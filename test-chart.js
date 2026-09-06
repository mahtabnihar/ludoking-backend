const http = require('http');

const data = JSON.stringify({
  username: 'admin',
  password: 'admin123'
});

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/auth/login',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': data.length
  }
}, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    const token = JSON.parse(body).accessToken;
    
    const req2 = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/dashboard/chart-data',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }, (res2) => {
      let body2 = '';
      res2.on('data', chunk => body2 += chunk);
      res2.on('end', () => console.log(body2));
    });
    req2.end();
  });
});
req.write(data);
req.end();
