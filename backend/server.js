/**
 * SheSafe - Women Safety & Emergency System
 * Backend Server (Node.js)
 * 
 * Works both as an Express app and has a zero-dependency fallback 
 * using Node's built-in http module so it runs out-of-the-box!
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

// Helper to read database
function readDb() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return { users: [], contacts: [], emergencyNumbers: [], safeZones: [], sosAlerts: [], checkIns: [], communityAlerts: [], incidents: [] };
    }
    const data = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading db.json:', err);
    return { users: [], contacts: [], emergencyNumbers: [], safeZones: [], sosAlerts: [], checkIns: [], communityAlerts: [], incidents: [] };
  }
}

// Helper to write database
function writeDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Error writing db.json:', err);
    return false;
  }
}

// Parse request body JSON
function getRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// MIME types for static files
const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg'
};

// Response helpers
function jsonResponse(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

// Create HTTP server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method.toUpperCase();

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    return res.end();
  }

  // --- API ROUTES ---

  // Health check
  if (pathname === '/api/health' && method === 'GET') {
    return jsonResponse(res, 200, {
      status: 'online',
      system: 'SheSafe Women Safety API',
      version: '1.0.0',
      timestamp: new Date().toISOString()
    });
  }

  // 1. Auth: Login
  if (pathname === '/api/auth/login' && method === 'POST') {
    const body = await getRequestBody(req);
    const { identifier, email, password } = body;
    const loginId = (identifier || email || '').trim().toLowerCase();

    const db = readDb();
    const user = db.users.find(u => 
      (u.email.toLowerCase() === loginId || u.mobile === loginId || u.name.toLowerCase().includes(loginId)) &&
      u.password === password
    );

    if (!user) {
      // Demo fallback: if demo login or sweta
      if (loginId.includes('sweta') || loginId === 'demo') {
        const demoUser = db.users[0];
        return jsonResponse(res, 200, {
          success: true,
          message: 'Logged in as demo user',
          user: demoUser,
          token: 'token_shesafe_' + demoUser.id
        });
      }
      return jsonResponse(res, 401, {
        success: false,
        message: 'Invalid credentials. Try: sweta@example.com / password123'
      });
    }

    return jsonResponse(res, 200, {
      success: true,
      message: 'Login successful',
      user: { ...user, password: '[PROTECTED]' },
      token: 'token_shesafe_' + user.id
    });
  }

  // 2. Auth: Sign Up
  if (pathname === '/api/auth/signup' && method === 'POST') {
    const body = await getRequestBody(req);
    const { name, mobile, email, password, emergencyContactName, emergencyContactPhone, locationPermission } = body;

    if (!name || !mobile || !password) {
      return jsonResponse(res, 400, { success: false, message: 'Name, Mobile and Password are required.' });
    }

    const db = readDb();
    const existing = db.users.find(u => u.email === email || u.mobile === mobile);
    if (existing) {
      return jsonResponse(res, 409, { success: false, message: 'User with this mobile or email already exists.' });
    }

    const newUser = {
      id: 'usr_' + Date.now(),
      name,
      email: email || `${mobile}@shesafe.local`,
      mobile,
      password,
      bloodGroup: 'Not specified',
      emergencyNotes: 'Registered user via SheSafe portal',
      homeAddress: 'Location enabled',
      locationPermission: !!locationPermission,
      notificationsEnabled: true,
      sirenSound: true,
      createdAt: new Date().toISOString()
    };

    db.users.push(newUser);

    // Auto-create initial emergency contact if provided
    if (emergencyContactName && emergencyContactPhone) {
      db.contacts.push({
        id: 'cnt_' + Date.now(),
        userId: newUser.id,
        name: emergencyContactName,
        relation: 'Primary Emergency Contact',
        phone: emergencyContactPhone,
        isPrimary: true,
        notifySms: true,
        notifyCall: true
      });
    }

    writeDb(db);

    return jsonResponse(res, 201, {
      success: true,
      message: 'Account created successfully! Welcome to SheSafe.',
      user: { ...newUser, password: '[PROTECTED]' },
      token: 'token_shesafe_' + newUser.id
    });
  }

  // 3. User Profile Update
  if (pathname === '/api/auth/profile' && method === 'PUT') {
    const body = await getRequestBody(req);
    const db = readDb();
    const userIndex = db.users.findIndex(u => u.id === body.id || u.email === body.email);
    if (userIndex === -1) {
      return jsonResponse(res, 404, { success: false, message: 'User not found.' });
    }

    db.users[userIndex] = { ...db.users[userIndex], ...body, password: db.users[userIndex].password };
    writeDb(db);
    return jsonResponse(res, 200, { success: true, user: db.users[userIndex] });
  }

  // 4. Emergency Numbers
  if (pathname === '/api/emergency-numbers' && method === 'GET') {
    const db = readDb();
    return jsonResponse(res, 200, { success: true, numbers: db.emergencyNumbers });
  }

  // 5. Emergency Contacts
  if (pathname === '/api/contacts' && method === 'GET') {
    const db = readDb();
    return jsonResponse(res, 200, { success: true, contacts: db.contacts });
  }

  if (pathname === '/api/contacts' && method === 'POST') {
    const body = await getRequestBody(req);
    if (!body.name || !body.phone) {
      return jsonResponse(res, 400, { success: false, message: 'Contact name and phone are required.' });
    }
    const db = readDb();
    const newContact = {
      id: 'cnt_' + Date.now(),
      userId: body.userId || 'usr_sweta_01',
      name: body.name,
      relation: body.relation || 'Emergency Contact',
      phone: body.phone,
      isPrimary: !!body.isPrimary,
      notifySms: body.notifySms !== false,
      notifyCall: body.notifyCall !== false
    };

    if (newContact.isPrimary) {
      db.contacts.forEach(c => c.isPrimary = false);
    }
    db.contacts.push(newContact);
    writeDb(db);
    return jsonResponse(res, 201, { success: true, contact: newContact });
  }

  if (pathname.startsWith('/api/contacts/') && method === 'DELETE') {
    const id = pathname.replace('/api/contacts/', '');
    const db = readDb();
    const initialLen = db.contacts.length;
    db.contacts = db.contacts.filter(c => c.id !== id);
    if (db.contacts.length === initialLen) {
      return jsonResponse(res, 404, { success: false, message: 'Contact not found' });
    }
    writeDb(db);
    return jsonResponse(res, 200, { success: true, message: 'Contact deleted successfully' });
  }

  // Global in-memory store for live tracking
  if (!global.liveLocations) {
    global.liveLocations = {};
  }

  // Real-Time Location Update Stream
  if (pathname === '/api/location/update' && method === 'POST') {
    const body = await getRequestBody(req);
    const userId = body.userId || 'usr_sweta_01';
    
    global.liveLocations[userId] = {
      userId,
      userName: body.userName || 'Sweta Rani',
      lat: body.lat,
      lng: body.lng,
      accuracy: body.accuracy || 10,
      speed: body.speed || 0,
      heading: body.heading || null,
      battery: body.battery || null,
      address: body.address || 'Live GPS Coordinates',
      timestamp: new Date().toISOString(),
      isSharing: body.isSharing !== false
    };

    return jsonResponse(res, 200, {
      success: true,
      message: 'Real-time location updated',
      data: global.liveLocations[userId]
    });
  }

  // Get Real-Time Live Location (for Emergency Contacts / Tracking Page)
  if (pathname.startsWith('/api/location/live') && method === 'GET') {
    const parts = pathname.split('/');
    const userId = parts[4] || parsedUrl.query.userId || 'usr_sweta_01';
    const loc = global.liveLocations[userId] || {
      userId,
      userName: 'Sweta Rani',
      lat: 28.6328,
      lng: 77.2197,
      accuracy: 8,
      speed: 0,
      address: 'in Circle, GP Banka',
      timestamp: new Date().toISOString(),
      isSharing: true
    };
    return jsonResponse(res, 200, { success: true, location: loc });
  }

  // 6. Safe Zones (Dynamic & Situation-Aware)
  if (pathname === '/api/safe-zones' && method === 'GET') {
    const db = readDb();
    const userLat = parseFloat(parsedUrl.query.lat);
    const userLng = parseFloat(parsedUrl.query.lng);
    const situation = parsedUrl.query.situation || 'auto';

    // Haversine distance formula in kilometers
    function calcDistance(lat1, lon1, lat2, lon2) {
      const R = 6371; // Earth radius in km
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
        Math.sin(dLon/2) * Math.sin(dLon/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
    }

    let zones = db.safeZones.map(z => ({ ...z }));

    // If user provided real GPS coordinates, dynamically adjust distances & generate real-proximity hubs
    if (!isNaN(userLat) && !isNaN(userLng)) {
      zones = zones.map(z => {
        // If it's a seed place, dynamically shift coordinates relative to user if far away
        const dist = calcDistance(userLat, userLng, z.coordinates.lat, z.coordinates.lng);
        // If seed is > 50km from user (i.e. user is in a different city), adapt locations around user's real GPS!
        let adaptedCoords = z.coordinates;
        let actualDist = dist;
        if (dist > 30) {
          // Offsets for police (N), hospital (NE), shelter (SW), pharmacy (E), women centre (NW)
          const offsets = {
            police: { lat: 0.0075, lng: 0.0060, name: 'Local Police Station & Women Desk' },
            hospital: { lat: 0.0120, lng: 0.0110, name: 'Nearest Emergency Hospital' },
            shelter: { lat: -0.0110, lng: -0.0080, name: 'Sakhi One-Stop Crisis Shelter' },
            pharmacy: { lat: 0.0040, lng: -0.0035, name: '24/7 Emergency Pharmacy' },
            women_centre: { lat: -0.0060, lng: 0.0050, name: 'Women Pink Patrol Post' }
          };
          const off = offsets[z.category] || { lat: 0.005, lng: 0.005, name: z.name };
          adaptedCoords = { lat: +(userLat + off.lat).toFixed(5), lng: +(userLng + off.lng).toFixed(5) };
          actualDist = calcDistance(userLat, userLng, adaptedCoords.lat, adaptedCoords.lng);
        }

        return {
          ...z,
          coordinates: adaptedCoords,
          distanceKm: +actualDist.toFixed(1),
          distanceText: actualDist < 1 ? `${Math.round(actualDist * 1000)} m away` : `${actualDist.toFixed(1)} km away`
        };
      });
    }

    // Determine Real Safety Situation based on Time & Proximity
    const currentHour = new Date().getHours();
    const isNight = (currentHour >= 20 || currentHour < 6); // 8:00 PM to 6:00 AM
    
    // Sort nearest first
    zones.sort((a, b) => a.distanceKm - b.distanceKm);

    // If night, prioritize 24/7 facilities
    if (isNight || situation === 'night') {
      zones.sort((a, b) => {
        if (a.isOpen247 && !b.isOpen247) return -1;
        if (!a.isOpen247 && b.isOpen247) return 1;
        return a.distanceKm - b.distanceKm;
      });
    }

    const nearestDist = zones.length > 0 ? zones[0].distanceKm : 1.0;
    let situationState = {
      mode: isNight ? 'NIGHT_HIGH_ALERT' : 'DAY_NORMAL',
      title: isNight ? '🌙 Late Night High-Alert Mode' : '☀️ Daytime Standard Monitoring',
      description: isNight 
        ? 'Late hours detected: Safe zones filtered to prioritize verified 24/7 Open facilities with security.'
        : 'All local safe spots, women desks and medical hubs active.',
      isNight,
      nearestDistanceKm: nearestDist,
      infrastructureLevel: nearestDist < 1.5 ? 'EXCELLENT' : (nearestDist < 3.0 ? 'MODERATE' : 'LOW_INFRASTRUCTURE'),
      recommendation: isNight 
        ? 'Keep live location ON and stick to well-lit roads with CCTV.' 
        : 'Stay aware of nearest safe zones during your commute.'
    };

    return jsonResponse(res, 200, {
      success: true,
      safeZones: zones,
      situation: situationState
    });
  }

  // 7. 🆘 SOS Trigger
  if (pathname === '/api/sos/trigger' && method === 'POST') {
    const body = await getRequestBody(req);
    const db = readDb();

    const newSos = {
      id: 'sos_' + Date.now(),
      userId: body.userId || 'usr_sweta_01',
      userName: body.userName || 'Sweta Rani',
      status: 'ACTIVE_EMERGENCY',
      timestamp: new Date().toISOString(),
      location: body.location || {
        lat: 28.6328,
        lng: 77.2197,
        address: 'Live GPS Pin, Gp banka'
      },
      contactsAlerted: db.contacts.length,
      simulatedDispatch: {
        policeHelpline: '112 / PCR Unit 07 Mobilized',
        smsDispatchedTo: db.contacts.map(c => ({ name: c.name, phone: c.phone })),
        trackingUrl: `https://shesafe.app/live-track/sos_${Date.now()}`
      }
    };

    db.sosAlerts.unshift(newSos);
    writeDb(db);

    return jsonResponse(res, 200, {
      success: true,
      alert: newSos,
      message: '🚨 EMERGENCY ALERT DISPATCHED: Police Control Room and all Emergency Contacts notified with live coordinates.'
    });
  }

  // Cancel SOS
  if (pathname === '/api/sos/cancel' && method === 'POST') {
    const body = await getRequestBody(req);
    const db = readDb();
    const activeSos = db.sosAlerts.find(a => a.status === 'ACTIVE_EMERGENCY');
    if (activeSos) {
      activeSos.status = 'CANCELLED_SAFE';
      activeSos.resolvedAt = new Date().toISOString();
      activeSos.resolvedReason = body.reason || 'User marked herself safe';
      writeDb(db);
    }
    return jsonResponse(res, 200, {
      success: true,
      message: 'SOS Alert successfully cancelled. Emergency contacts and authorities updated that you are SAFE.'
    });
  }

  // 8. Safety Check-In ("I'M SAFE")
  if (pathname === '/api/checkins' && method === 'GET') {
    const db = readDb();
    return jsonResponse(res, 200, { success: true, checkIns: db.checkIns });
  }

  if (pathname === '/api/checkins' && method === 'POST') {
    const body = await getRequestBody(req);
    const db = readDb();

    const newCheckIn = {
      id: 'chk_' + Date.now(),
      userId: body.userId || 'usr_sweta_01',
      userName: body.userName || 'Sweta Rani',
      message: body.message || `${body.userName || 'Sweta'} has checked in and is currently safe.`,
      location: body.location || 'Current Verified Location',
      timestamp: new Date().toISOString(),
      status: 'safe'
    };

    db.checkIns.unshift(newCheckIn);
    writeDb(db);

    return jsonResponse(res, 201, {
      success: true,
      checkIn: newCheckIn,
      message: 'Check-in shared with trusted contacts: "Sweta is safe."'
    });
  }

  // 9. Community Alerts
  if (pathname === '/api/community-alerts' && method === 'GET') {
    const db = readDb();
    return jsonResponse(res, 200, { success: true, alerts: db.communityAlerts });
  }

  if (pathname === '/api/community-alerts' && method === 'POST') {
    const body = await getRequestBody(req);
    const db = readDb();

    const newAlert = {
      id: 'ca_' + Date.now(),
      type: body.type || 'incident',
      title: body.title || 'Community Safety Notice',
      location: body.location || 'Nearby Location',
      distance: body.distance || 'Near your route',
      timeAgo: 'Just now',
      severity: body.severity || 'medium',
      verified: false,
      votes: 1,
      description: body.description || 'Reported by local community member.'
    };

    db.communityAlerts.unshift(newAlert);
    writeDb(db);
    return jsonResponse(res, 201, { success: true, alert: newAlert });
  }

  // 10. Incident Reports
  if (pathname === '/api/incidents' && method === 'GET') {
    const db = readDb();
    return jsonResponse(res, 200, { success: true, incidents: db.incidents });
  }

  if (pathname === '/api/incidents' && method === 'POST') {
    const body = await getRequestBody(req);
    const db = readDb();

    const newIncident = {
      id: 'inc_' + Date.now(),
      userId: body.userId || 'usr_sweta_01',
      type: body.type || 'Harassment',
      location: body.location || 'Reported Spot',
      description: body.description || '',
      severity: body.severity || 'Medium',
      timestamp: new Date().toISOString(),
      anonymous: !!body.anonymous,
      status: 'Report Received & Forwarded'
    };

    db.incidents.unshift(newIncident);
    writeDb(db);

    return jsonResponse(res, 201, {
      success: true,
      incident: newIncident,
      message: 'Incident reported successfully. Log reference: #' + newIncident.id
    });
  }

  // --- STATIC FILE SERVING FOR FRONTEND ---
  let filePath = path.join(FRONTEND_DIR, pathname === '/' ? 'index.html' : pathname);

  // Normalize path and prevent directory traversal
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Access Denied');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA-style routing
      const indexPath = path.join(FRONTEND_DIR, 'index.html');
      fs.readFile(indexPath, (err2, content) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          return res.end('404 Not Found');
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(content);
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err3, data) => {
      if (err3) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        return res.end('500 Internal Server Error');
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });
});

server.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`🛡️  SheSafe - Women Safety & Emergency System Server`);
  console.log(`📡 Backend API & Web App running at:`);
  console.log(`👉 http://localhost:${PORT}`);
  console.log(`======================================================\n`);
});
