// enrich.js - FIXED
// Mission: Every NOW stored. Simple. Works.
// No pattern matching. No decisions. Everything goes in.

import { MongoClient } from 'mongodb';

const MONGO_URI = process.env.MONGODB_URI;
const DB_NAME = 'stcky';

let client;
let db;

async function getDb() {
  if (!client) {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
  }
  return db;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  const { message, userId } = req.body;
  
  if (!message || !userId) {
    return res.status(400).json({ error: 'message and userId required' });
  }

  const now = new Date();
  const db = await getDb();
  const memories = db.collection('memories');

  // STORE EVERYTHING. No pattern matching. No decisions.
  // The conversation IS the content.
  const memory = {
    userId,
    category: 'conversation',
    key: `now-${now.getTime()}`,
    value: message,
    relevantDate: now.toISOString(),
    createdAt: now,
    updatedAt: now,
    source: 'enrich-auto'
  };

  try {
    await memories.insertOne(memory);
  } catch (err) {
    console.error('Store failed:', err);
    // Don't fail the request - log and continue
  }

  // Now do domain detection for anchor surfacing
  const domains = detectDomains(message);
  
  // Find relevant memories - associative recall
  const pipeline = [
    { $match: { userId } },
    { $sort: { relevantDate: -1, updatedAt: -1 } },
    { $limit: 20 }
  ];

  // If domain detected, also surface anchors for that domain
  if (domains.length > 0) {
    const anchors = await memories.find({
      userId,
      anchor: true,
      domain: { $in: domains }
    }).toArray();
    
    const recent = await memories.aggregate(pipeline).toArray();
    
    return res.status(200).json({
      stored: true,
      storedKey: memory.key,
      domains,
      anchors,
      recent
    });
  }

  const recent = await memories.aggregate(pipeline).toArray();
  
  return res.status(200).json({
    stored: true,
    storedKey: memory.key,
    domains: [],
    anchors: [],
    recent
  });
}

function detectDomains(message) {
  const domains = [];
  const lower = message.toLowerCase();
  
  if (/blood|medical|doctor|hospital|health|prescription|diagnosis|symptom|surgery|medication/i.test(lower)) {
    domains.push('medical');
  }
  if (/bank|invest|tax|ira|401k|income|salary|payment|invoice|stripe|paypal/i.test(lower)) {
    domains.push('financial');
  }
  if (/wife|husband|son|daughter|mother|father|family|chalam|wedding|anniversary/i.test(lower)) {
    domains.push('family');
  }
  if (/court|lawsuit|complaint|attorney|legal|filing|plaintiff|defendant|judge|hearing/i.test(lower)) {
    domains.push('legal');
  }
  if (/flight|hotel|travel|trip|passport|visa|airport|destination/i.test(lower)) {
    domains.push('travel');
  }
  if (/stcky|mcp|deploy|vercel|api|code|build|server|database/i.test(lower)) {
    domains.push('work');
  }
  
  return domains;
}
