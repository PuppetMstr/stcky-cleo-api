const { MongoClient, ObjectId } = require('mongodb');

const uri = process.env.MONGODB_URI;

async function getDb() {
  const client = new MongoClient(uri);
  await client.connect();
  return client.db('cleo');
}

// Check if user has access to project (owner, member, or team member)
async function hasProjectAccess(db, project, userId) {
  // Direct owner or member
  if (project.ownerId.equals(userId)) return 'owner';
  if (project.memberIds?.some(id => id.equals(userId))) return 'member';
  
  // Team-based access
  if (project.teamId) {
    const team = await db.collection('teams').findOne({
      _id: project.teamId,
      $or: [
        { ownerId: userId },
        { adminIds: userId },
        { memberIds: userId }
      ]
    });
    if (team) {
      if (team.ownerId.equals(userId)) return 'team_owner';
      if (team.adminIds?.some(id => id.equals(userId))) return 'team_admin';
      return 'team_member';
    }
  }
  
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer cleo_')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const apiKey = auth.slice(7);
  
  try {
    const db = await getDb();
    const user = await db.collection('users').findOne({ apiKey });
    if (!user) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // GET - List projects user owns, is member of, or has team access to
    if (req.method === 'GET') {
      const { id, teamId } = req.query;
      
      // Get specific project
      if (id) {
        const project = await db.collection('projects').findOne({ _id: new ObjectId(id) });
        
        if (!project) {
          return res.status(404).json({ error: 'Project not found' });
        }
        
        const role = await hasProjectAccess(db, project, user._id);
        if (!role) {
          return res.status(403).json({ error: 'No access to this project' });
        }
        
        // Get member details
        const memberIds = [project.ownerId, ...(project.memberIds || [])];
        const members = await db.collection('users')
          .find({ _id: { $in: memberIds } })
          .project({ _id: 1, email: 1, name: 1 })
          .toArray();
        
        // Get memory count
        const memoryCount = await db.collection('memories').countDocuments({ 
          projectId: project._id 
        });
        
        // Get team info if linked
        let team = null;
        if (project.teamId) {
          team = await db.collection('teams').findOne(
            { _id: project.teamId },
            { projection: { name: 1, description: 1 } }
          );
        }
        
        return res.json({ 
          project: {
            ...project,
            members,
            memoryCount,
            team,
            role
          }
        });
      }
      
      // List projects by team
      if (teamId) {
        const team = await db.collection('teams').findOne({
          _id: new ObjectId(teamId),
          $or: [
            { ownerId: user._id },
            { adminIds: user._id },
            { memberIds: user._id }
          ]
        });
        
        if (!team) {
          return res.status(403).json({ error: 'No access to this team' });
        }
        
        const projects = await db.collection('projects')
          .find({ teamId: new ObjectId(teamId) })
          .sort({ updatedAt: -1 })
          .toArray();
        
        for (const project of projects) {
          project.memoryCount = await db.collection('memories').countDocuments({ 
            projectId: project._id 
          });
          project.role = await hasProjectAccess(db, project, user._id);
        }
        
        return res.json({ projects, team: { _id: team._id, name: team.name } });
      }
      
      // List all accessible projects
      // Get user's teams first
      const userTeams = await db.collection('teams')
        .find({
          $or: [
            { ownerId: user._id },
            { adminIds: user._id },
            { memberIds: user._id }
          ]
        })
        .project({ _id: 1 })
        .toArray();
      const teamIds = userTeams.map(t => t._id);
      
      const projects = await db.collection('projects')
        .find({
          $or: [
            { ownerId: user._id },
            { memberIds: user._id },
            { teamId: { $in: teamIds } }
          ]
        })
        .sort({ updatedAt: -1 })
        .toArray();
      
      for (const project of projects) {
        project.memoryCount = await db.collection('memories').countDocuments({ 
          projectId: project._id 
        });
        project.role = await hasProjectAccess(db, project, user._id);
      }
      
      return res.json({ projects });
    }
    
    // POST - Create new project
    if (req.method === 'POST') {
      const { name, description, teamId } = req.body;
      
      if (!name) {
        return res.status(400).json({ error: 'name required' });
      }
      
      // If teamId, verify user is team owner or admin
      let teamObjId = null;
      if (teamId) {
        const team = await db.collection('teams').findOne({
          _id: new ObjectId(teamId),
          $or: [
            { ownerId: user._id },
            { adminIds: user._id }
          ]
        });
        if (!team) {
          return res.status(403).json({ error: 'Must be team owner or admin to create team projects' });
        }
        teamObjId = team._id;
      }
      
      const now = new Date();
      const project = {
        name,
        description: description || '',
        ownerId: user._id,
        memberIds: [],
        createdAt: now,
        updatedAt: now
      };
      
      if (teamObjId) {
        project.teamId = teamObjId;
      }
      
      const result = await db.collection('projects').insertOne(project);
      project._id = result.insertedId;
      
      return res.json({ 
        success: true, 
        project: {
          _id: project._id,
          name: project.name,
          description: project.description,
          teamId: teamId || null,
          role: 'owner',
          memoryCount: 0
        }
      });
    }
    
    // PUT - Update project
    if (req.method === 'PUT') {
      const { id, name, description, addMemberEmail, removeMemberId, teamId, unlinkTeam } = req.body;
      
      if (!id) {
        return res.status(400).json({ error: 'id required' });
      }
      
      const project = await db.collection('projects').findOne({ _id: new ObjectId(id) });
      if (!project) {
        return res.status(404).json({ error: 'Project not found' });
      }
      
      const role = await hasProjectAccess(db, project, user._id);
      if (!role || !['owner', 'team_owner', 'team_admin'].includes(role)) {
        return res.status(403).json({ error: 'Must be owner or team admin to update project' });
      }
      
      const updates = { updatedAt: new Date() };
      
      if (name) updates.name = name;
      if (description !== undefined) updates.description = description;
      
      // Link to team
      if (teamId) {
        const team = await db.collection('teams').findOne({
          _id: new ObjectId(teamId),
          $or: [
            { ownerId: user._id },
            { adminIds: user._id }
          ]
        });
        if (!team) {
          return res.status(403).json({ error: 'Must be team owner or admin to link project' });
        }
        updates.teamId = team._id;
      }
      
      // Unlink from team
      if (unlinkTeam && project.ownerId.equals(user._id)) {
        await db.collection('projects').updateOne(
          { _id: project._id },
          { $unset: { teamId: '' }, $set: { updatedAt: new Date() } }
        );
        return res.json({ success: true, message: 'Project unlinked from team' });
      }
      
      // Add member by email
      if (addMemberEmail) {
        const newMember = await db.collection('users').findOne({ email: addMemberEmail });
        if (!newMember) {
          return res.status(404).json({ error: 'User not found with that email' });
        }
        if (newMember._id.equals(user._id)) {
          return res.status(400).json({ error: 'Cannot add yourself' });
        }
        if (project.memberIds?.some(mid => mid.equals(newMember._id))) {
          return res.status(400).json({ error: 'User already a member' });
        }
        
        await db.collection('projects').updateOne(
          { _id: project._id },
          { 
            $addToSet: { memberIds: newMember._id },
            $set: updates
          }
        );
        
        return res.json({ 
          success: true, 
          message: `Added ${addMemberEmail} to project`,
          memberId: newMember._id
        });
      }
      
      // Remove member
      if (removeMemberId) {
        await db.collection('projects').updateOne(
          { _id: project._id },
          { 
            $pull: { memberIds: new ObjectId(removeMemberId) },
            $set: updates
          }
        );
        
        return res.json({ success: true, message: 'Member removed' });
      }
      
      // Apply updates
      await db.collection('projects').updateOne(
        { _id: project._id },
        { $set: updates }
      );
      
      return res.json({ success: true, message: 'Project updated' });
    }
    
    // DELETE - Delete project (only owner)
    if (req.method === 'DELETE') {
      const { id, deleteMemories } = req.query;
      
      if (!id) {
        return res.status(400).json({ error: 'id required' });
      }
      
      const project = await db.collection('projects').findOne({
        _id: new ObjectId(id),
        ownerId: user._id
      });
      
      if (!project) {
        return res.status(404).json({ error: 'Project not found or not owner' });
      }
      
      if (deleteMemories === 'true') {
        await db.collection('memories').deleteMany({ projectId: project._id });
        await db.collection('edges').deleteMany({ projectId: project._id });
      }
      
      await db.collection('projects').deleteOne({ _id: project._id });
      
      return res.json({ 
        success: true, 
        message: deleteMemories === 'true' 
          ? 'Project, memories, and edges deleted' 
          : 'Project deleted (data preserved)'
      });
    }
    
    return res.status(405).json({ error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Projects error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
  }
};
