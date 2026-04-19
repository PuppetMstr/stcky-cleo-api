const { getDb, auth, cors, ObjectId } = require('./_lib/auth');

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = await auth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const db = await getDb();

    // GET - List teams user owns or is member of
    if (req.method === 'GET') {
      const { id } = req.query;

      if (id) {
        const team = await db.collection('teams').findOne({
          _id: new ObjectId(id),
          $or: [
            { ownerId: user._id },
            { adminIds: user._id },
            { memberIds: user._id }
          ]
        });

        if (!team) {
          return res.status(404).json({ error: 'Team not found' });
        }

        const allMemberIds = [
          team.ownerId,
          ...(team.adminIds || []),
          ...(team.memberIds || [])
        ];
        const members = await db.collection('users')
          .find({ _id: { $in: allMemberIds } })
          .project({ _id: 1, email: 1, name: 1, lastSeen: 1 })
          .toArray();

        const projectCount = await db.collection('projects').countDocuments({ teamId: team._id });

        const projects = await db.collection('projects').find({ teamId: team._id }).toArray();
        let memoryCount = 0;
        for (const p of projects) {
          memoryCount += await db.collection('memories').countDocuments({ projectId: p._id });
        }

        return res.json({
          team: {
            ...team,
            members,
            projectCount,
            memoryCount,
            role: team.ownerId.equals(user._id) ? 'owner' :
                  team.adminIds?.some(id => id.equals(user._id)) ? 'admin' : 'member'
          }
        });
      }

      const teams = await db.collection('teams')
        .find({
          $or: [
            { ownerId: user._id },
            { adminIds: user._id },
            { memberIds: user._id }
          ]
        })
        .sort({ updatedAt: -1 })
        .toArray();

      for (const team of teams) {
        team.memberCount = 1 + (team.adminIds?.length || 0) + (team.memberIds?.length || 0);
        team.role = team.ownerId.equals(user._id) ? 'owner' :
                    team.adminIds?.some(id => id.equals(user._id)) ? 'admin' : 'member';
      }

      return res.json({ teams });
    }

    // POST - Create new team
    if (req.method === 'POST') {
      const { name, description } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'name required' });
      }

      const now = new Date();
      const team = {
        name,
        description: description || '',
        ownerId: user._id,
        adminIds: [],
        memberIds: [],
        createdAt: now,
        updatedAt: now
      };

      const result = await db.collection('teams').insertOne(team);
      team._id = result.insertedId;

      return res.json({
        success: true,
        team: {
          _id: team._id,
          name: team.name,
          description: team.description,
          role: 'owner',
          memberCount: 1
        }
      });
    }

    // PUT - Update team
    if (req.method === 'PUT') {
      const { id, name, description, addMemberEmail, removeMemberId, promoteToAdmin, demoteToMember } = req.body;

      if (!id) {
        return res.status(400).json({ error: 'id required' });
      }

      const team = await db.collection('teams').findOne({
        _id: new ObjectId(id),
        $or: [
          { ownerId: user._id },
          { adminIds: user._id }
        ]
      });

      if (!team) {
        return res.status(404).json({ error: 'Team not found or insufficient permissions' });
      }

      const isOwner = team.ownerId.equals(user._id);
      const updates = { updatedAt: new Date() };

      if (name) updates.name = name;
      if (description !== undefined) updates.description = description;

      if (addMemberEmail) {
        const newMember = await db.collection('users').findOne({ email: addMemberEmail });
        if (!newMember) return res.status(404).json({ error: 'User not found with that email' });
        if (newMember._id.equals(user._id)) return res.status(400).json({ error: 'Cannot add yourself' });
        const allMembers = [team.ownerId, ...(team.adminIds || []), ...(team.memberIds || [])];
        if (allMembers.some(id => id.equals(newMember._id))) return res.status(400).json({ error: 'User already in team' });

        await db.collection('teams').updateOne(
          { _id: team._id },
          { $addToSet: { memberIds: newMember._id }, $set: updates }
        );
        return res.json({ success: true, message: `Added ${addMemberEmail} to team`, memberId: newMember._id });
      }

      if (removeMemberId) {
        const targetId = new ObjectId(removeMemberId);
        if (team.adminIds?.some(id => id.equals(targetId)) && !isOwner) return res.status(403).json({ error: 'Only owner can remove admins' });
        if (targetId.equals(team.ownerId)) return res.status(400).json({ error: 'Cannot remove owner' });

        await db.collection('teams').updateOne(
          { _id: team._id },
          { $pull: { memberIds: targetId, adminIds: targetId }, $set: updates }
        );
        return res.json({ success: true, message: 'Member removed' });
      }

      if (promoteToAdmin) {
        if (!isOwner) return res.status(403).json({ error: 'Only owner can promote to admin' });
        await db.collection('teams').updateOne(
          { _id: team._id },
          { $pull: { memberIds: new ObjectId(promoteToAdmin) }, $addToSet: { adminIds: new ObjectId(promoteToAdmin) }, $set: updates }
        );
        return res.json({ success: true, message: 'Promoted to admin' });
      }

      if (demoteToMember) {
        if (!isOwner) return res.status(403).json({ error: 'Only owner can demote admins' });
        await db.collection('teams').updateOne(
          { _id: team._id },
          { $pull: { adminIds: new ObjectId(demoteToMember) }, $addToSet: { memberIds: new ObjectId(demoteToMember) }, $set: updates }
        );
        return res.json({ success: true, message: 'Demoted to member' });
      }

      await db.collection('teams').updateOne({ _id: team._id }, { $set: updates });
      return res.json({ success: true, message: 'Team updated' });
    }

    // DELETE - Delete team (owner only)
    if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });

      const team = await db.collection('teams').findOne({ _id: new ObjectId(id), ownerId: user._id });
      if (!team) return res.status(404).json({ error: 'Team not found or not owner' });

      await db.collection('projects').updateMany({ teamId: team._id }, { $unset: { teamId: '' } });
      await db.collection('teams').deleteOne({ _id: team._id });

      return res.json({ success: true, message: 'Team deleted. Projects preserved.' });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (error) {
    console.error('Teams error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
