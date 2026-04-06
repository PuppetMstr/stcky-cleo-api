const { MongoClient } = require('mongodb');
const crypto = require('crypto');

const uri = process.env.MONGODB_URI;
const client = new MongoClient(uri);

function getAction(url) {
  if (url.includes('/auth/signup')) return 'signup';
  if (url.includes('/oauth/token')) return 'token';
  return 'authorize';
}

function generateApiKey() {
  return 'cleo_' + crypto.randomBytes(16).toString('hex');
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const action = getAction(req.url);

  // ============ SIGNUP (from pricing.html) ============
  if (action === 'signup') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    
    const { email, password, profile } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }
    
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    
    try {
      await client.connect();
      const db = client.db('cleo');
      
      // Check for existing user
      const existing = await db.collection('users').findOne({ email: email.toLowerCase() });
      if (existing) {
        return res.status(409).json({ error: 'Email already registered' });
      }
      
      const apiKey = generateApiKey();
      const now = new Date();
      
      // Create user
      const user = {
        email: email.toLowerCase(),
        passwordHash: hashPassword(password),
        apiKey,
        plan: 'free',
        memoryCount: 0,
        memoryLimit: 100,
        projectLimit: 3,
        createdAt: now,
        updatedAt: now
      };
      
      const userResult = await db.collection('users').insertOne(user);
      const userId = userResult.insertedId;
      
      // If profile data provided, save as form-fill-profile memory
      if (profile && typeof profile === 'object') {
        const formFillProfile = {
          firstName: profile.firstName || '',
          lastName: profile.lastName || '',
          email: email.toLowerCase(),
          phone: profile.phone || '',
          company: profile.company || '',
          title: profile.title || '',
          city: profile.city || '',
          state: profile.state || '',
          zip: profile.zip || '',
          country: profile.country || 'United States'
        };
        
        const memory = {
          userId,
          category: 'preference',
          key: 'form-fill-profile',
          value: JSON.stringify(formFillProfile),
          tags: 'guardian,form-fill,profile',
          source: 'signup',
          importanceScore: 8,
          stabilityScore: 9,
          createdAt: now,
          updatedAt: now
        };
        
        await db.collection('memories').insertOne(memory);
        
        await db.collection('users').updateOne(
          { _id: userId },
          { $inc: { memoryCount: 1 } }
        );
      }
      
      return res.json({
        success: true,
        email: user.email,
        apiKey: user.apiKey,
        plan: user.plan,
        limits: {
          memories: user.memoryLimit,
          projects: user.projectLimit
        }
      });
      
    } catch (error) {
      console.error('Signup error:', error);
      return res.status(500).json({ error: 'Signup failed' });
    }
  }

  // ============ TOKEN ============
  if (action === 'token') {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    
    let body = req.body;
    if (typeof body === 'string') body = Object.fromEntries(new URLSearchParams(body));
    
    const { grant_type, code, refresh_token } = body;
    
    try {
      if (grant_type === 'authorization_code') {
        if (!code) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing code' });
        
        try {
          const decoded = JSON.parse(Buffer.from(code.replace('stcky_code_', ''), 'base64').toString());
          if (Date.now() > decoded.exp) return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
          
          const accessToken = 'stcky_' + Buffer.from(JSON.stringify({
            userId: decoded.userId, type: 'access', iat: Date.now()
          })).toString('base64');
          
          const refreshToken = 'stcky_refresh_' + Buffer.from(JSON.stringify({
            userId: decoded.userId, type: 'refresh', iat: Date.now()
          })).toString('base64');
          
          return res.status(200).json({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 31536000,
            refresh_token: refreshToken
          });
        } catch (e) {
          return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid code' });
        }
        
      } else if (grant_type === 'refresh_token') {
        if (!refresh_token) return res.status(400).json({ error: 'invalid_request', error_description: 'Missing refresh_token' });
        
        try {
          const decoded = JSON.parse(Buffer.from(refresh_token.replace('stcky_refresh_', ''), 'base64').toString());
          if (decoded.type !== 'refresh') return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
          
          const accessToken = 'stcky_' + Buffer.from(JSON.stringify({
            userId: decoded.userId, type: 'access', iat: Date.now()
          })).toString('base64');
          
          return res.status(200).json({
            access_token: accessToken,
            token_type: 'Bearer',
            expires_in: 31536000
          });
        } catch (e) {
          return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid refresh token' });
        }
      } else {
        return res.status(400).json({ error: 'unsupported_grant_type' });
      }
    } catch (error) {
      console.error('OAuth token error:', error);
      return res.status(500).json({ error: 'server_error' });
    }
  }

  // ============ AUTHORIZE ============
  const { client_id, redirect_uri, state, response_type } = req.query;
  
  if (req.method === 'GET') {
    const mode = req.query.mode || 'login';
    const html = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${mode === 'signup' ? 'Create STCKY Account' : 'Sign in to STCKY'}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; margin: 0; padding: 20px; }
    .container { background: #16213e; padding: 40px; border-radius: 12px; width: 100%; max-width: 400px; }
    h1 { margin: 0 0 8px 0; font-size: 24px; color: #f5a623; }
    p.subtitle { margin: 0 0 24px 0; color: #888; font-size: 14px; }
    label { display: block; margin-bottom: 6px; font-size: 14px; color: #ccc; }
    input { width: 100%; padding: 12px; margin-bottom: 16px; border: 1px solid #333; border-radius: 6px; background: #0f0f1a; color: #fff; font-size: 16px; }
    input:focus { outline: none; border-color: #f5a623; }
    button { width: 100%; padding: 14px; background: #f5a623; color: #1a1a2e; border: none; border-radius: 6px; font-size: 16px; font-weight: 600; cursor: pointer; }
    button:hover { background: #e5961f; }
    button:disabled { background: #666; cursor: not-allowed; }
    .error { background: #ff4444; color: #fff; padding: 12px; border-radius: 6px; margin-bottom: 16px; display: none; }
    .success { background: #44aa44; color: #fff; padding: 12px; border-radius: 6px; margin-bottom: 16px; display: none; }
    .toggle { text-align: center; margin-top: 16px; font-size: 14px; color: #888; }
    .toggle a { color: #f5a623; text-decoration: none; cursor: pointer; }
    .name-row { display: flex; gap: 12px; }
    .name-row > div { flex: 1; }
    .hidden { display: none; }
  </style>
</head>
<body>
  <div class="container">
    <h1 id="title">${mode === 'signup' ? 'Create Account' : 'Sign In'}</h1>
    <p class="subtitle" id="subtitle">${mode === 'signup' ? 'Your AI will finally know you' : 'Connect your memory to AI'}</p>
    <div class="error" id="error"></div>
    <div class="success" id="success"></div>
    <form id="authForm">
      <input type="hidden" name="client_id" value="${client_id || ''}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri || ''}">
      <input type="hidden" name="state" value="${state || ''}">
      <input type="hidden" name="mode" id="modeInput" value="${mode}">
      <div id="nameFields" class="${mode === 'signup' ? 'name-row' : 'hidden'}">
        <div><label>First Name</label><input type="text" id="firstName" name="firstName"></div>
        <div><label>Last Name</label><input type="text" id="lastName" name="lastName"></div>
      </div>
      <label>Email</label><input type="email" id="email" name="email" required>
      <label>Password</label><input type="password" id="password" name="password" required minlength="6">
      <div id="confirmField" class="${mode === 'signup' ? '' : 'hidden'}">
        <label>Confirm Password</label><input type="password" id="confirmPassword" name="confirmPassword">
      </div>
      <button type="submit" id="submitBtn">${mode === 'signup' ? 'Create Account' : 'Sign In'}</button>
    </form>
    <div class="toggle">
      <span id="toggleText">${mode === 'signup' ? 'Already have an account?' : "Don't have an account?"}</span>
      <a id="toggleLink" onclick="toggleMode()">${mode === 'signup' ? 'Sign In' : 'Sign Up'}</a>
    </div>
  </div>
  <script>
    let isSignup = ${mode === 'signup'};
    function toggleMode() {
      isSignup = !isSignup;
      document.getElementById('title').textContent = isSignup ? 'Create Account' : 'Sign In';
      document.getElementById('subtitle').textContent = isSignup ? 'Your AI will finally know you' : 'Connect your memory to AI';
      document.getElementById('nameFields').className = isSignup ? 'name-row' : 'hidden';
      document.getElementById('confirmField').className = isSignup ? '' : 'hidden';
      document.getElementById('submitBtn').textContent = isSignup ? 'Create Account' : 'Sign In';
      document.getElementById('toggleText').textContent = isSignup ? 'Already have an account?' : "Don't have an account?";
      document.getElementById('toggleLink').textContent = isSignup ? 'Sign In' : 'Sign Up';
      document.getElementById('modeInput').value = isSignup ? 'signup' : 'login';
      document.getElementById('error').style.display = 'none';
      document.getElementById('success').style.display = 'none';
    }
    document.getElementById('authForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.target;
      const errorDiv = document.getElementById('error');
      const successDiv = document.getElementById('success');
      const submitBtn = document.getElementById('submitBtn');
      errorDiv.style.display = 'none';
      successDiv.style.display = 'none';
      if (isSignup && form.password.value !== form.confirmPassword.value) {
        errorDiv.textContent = 'Passwords do not match';
        errorDiv.style.display = 'block';
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = isSignup ? 'Creating...' : 'Signing in...';
      try {
        const res = await fetch('/api/oauth/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: isSignup ? 'signup' : 'login',
            email: form.email.value,
            password: form.password.value,
            firstName: form.firstName?.value || '',
            lastName: form.lastName?.value || '',
            client_id: form.client_id.value,
            redirect_uri: form.redirect_uri.value,
            state: form.state.value
          })
        });
        const data = await res.json();
        if (data.redirect) {
          successDiv.textContent = isSignup ? 'Account created! Redirecting...' : 'Success! Redirecting...';
          successDiv.style.display = 'block';
          setTimeout(() => { window.location.href = data.redirect; }, 500);
        } else {
          errorDiv.textContent = data.error || 'Something went wrong';
          errorDiv.style.display = 'block';
          submitBtn.disabled = false;
          submitBtn.textContent = isSignup ? 'Create Account' : 'Sign In';
        }
      } catch (err) {
        errorDiv.textContent = 'Connection error. Please try again.';
        errorDiv.style.display = 'block';
        submitBtn.disabled = false;
        submitBtn.textContent = isSignup ? 'Create Account' : 'Sign In';
      }
    });
  </script>
</body>
</html>`;
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(html);
  }
  
  if (req.method === 'POST') {
    const { mode, email, password, firstName, lastName, client_id, redirect_uri, state } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    
    try {
      await client.connect();
      const db = client.db('cleo');
      const users = db.collection('users');
      
      if (mode === 'signup') {
        const existing = await users.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(400).json({ error: 'An account with this email already exists. Please sign in.' });
        
        const apiKey = 'cleo_' + crypto.randomBytes(16).toString('hex');
        const newUser = {
          email: email.toLowerCase(),
          password: password,
          apiKey: apiKey,
          firstName: firstName || '',
          lastName: lastName || '',
          plan: 'free',
          memoryLimit: 100,
          createdAt: new Date(),
          updatedAt: new Date()
        };
        
        const result = await users.insertOne(newUser);
        const authCode = 'stcky_code_' + Buffer.from(JSON.stringify({ userId: result.insertedId.toString(), exp: Date.now() + 600000 })).toString('base64');
        const redirectUrl = new URL(redirect_uri);
        redirectUrl.searchParams.set('code', authCode);
        if (state) redirectUrl.searchParams.set('state', state);
        return res.status(200).json({ redirect: redirectUrl.toString() });
      } else {
        const user = await users.findOne({ email: email.toLowerCase() });
        if (!user || (user.password !== password && user.apiKey !== password)) return res.status(401).json({ error: 'Invalid email or password' });
        
        const authCode = 'stcky_code_' + Buffer.from(JSON.stringify({ userId: user._id.toString(), exp: Date.now() + 600000 })).toString('base64');
        const redirectUrl = new URL(redirect_uri);
        redirectUrl.searchParams.set('code', authCode);
        if (state) redirectUrl.searchParams.set('state', state);
        return res.status(200).json({ redirect: redirectUrl.toString() });
      }
    } catch (error) {
      console.error('OAuth authorize error:', error);
      return res.status(500).json({ error: 'Server error. Please try again.' });
    }
  }
  
  return res.status(405).json({ error: 'Method not allowed' });
};
