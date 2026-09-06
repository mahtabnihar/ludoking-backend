const http = require('http');

const apiToken = 'admin-token-1234'; // Use the default admin token from server.js

function createRoom(index) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      call_back: 'http://localhost:3000/callback',
      entry_fee: 10,
      winning_prize: 50,
      room_type: 'public',
      uid: `user_${index}`
    });

    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/create-room',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': apiToken,
        'Content-Length': data.length
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        resolve({ index, statusCode: res.statusCode, data: JSON.parse(body) });
      });
    });

    req.on('error', (err) => reject(err));
    req.write(data);
    req.end();
  });
}

async function runTest() {
  console.log('Sending 10 concurrent public room creation requests...');
  try {
    const promises = [];
    for (let i = 1; i <= 10; i++) {
      promises.push(createRoom(i));
    }
    const results = await Promise.all(promises);
    console.log('\nResults:');
    results.forEach(res => {
      console.log(`Request #${res.index}: HTTP ${res.statusCode} - Room ID: ${res.data.room_id}`);
    });
  } catch (err) {
    console.error('Test error:', err);
  }
}

runTest();
