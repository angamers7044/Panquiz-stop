# 🎯 Panquiz Web Client

A modern web interface for the Panquiz automated quiz client. This version provides a beautiful, user-friendly interface that runs in your browser while using the same powerful automation logic as the original CLI version.

## ✨ Features

- **🌐 Web-based Interface**: Clean, modern UI accessible from any browser
- **🔄 Real-time Updates**: Live connection status and question count tracking
- **📱 Responsive Design**: Works on desktop, tablet, and mobile devices
- **🚀 Auto-answering**: Automatically answers quiz questions with correct responses
- **📊 Live Statistics**: Track questions answered and connection status
- **🔌 Easy Connection Management**: Simple connect/disconnect functionality

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Start the Web Server
```bash
npm run web
```

### 3. Open in Browser
Navigate to `http://localhost:3000` in your web browser.

### 4. Join a Game
1. Enter the Panquiz game PIN
2. Enter your player name
3. Click "Join Game"
4. Watch the magic happen! ✨

## 📁 Project Structure

```
├── public/
│   └── index.html          # Modern web interface
├── server.js               # Express.js proxy server
├── validate_pin.js         # PIN validation logic
├── negotiate_connection.js # SignalR negotiation
├── connect_signalr.js      # WebSocket management
└── package.json           # Dependencies and scripts
```

## 🔧 How It Works

The web client uses a **proxy architecture**:

1. **Frontend** (`public/index.html`): Beautiful web interface with real-time updates
2. **Proxy Server** (`server.js`): Express.js server that bridges web requests to your existing Node.js logic
3. **Game Logic**: Your original modules handle PIN validation, SignalR negotiation, and WebSocket communication

```
Browser → Express Server → Existing Node.js Logic → Panquiz API
   ↑                                                      ↓
   └─────────── Real-time Updates ←─────────────────────┘
```

## 🎮 API Endpoints

### Join Game
```http
POST /api/join
Content-Type: application/json

{
  "pin": "123456",
  "playerName": "YourName"
}
```

### Check Status
```http
GET /api/status/{connectionId}
```

### Disconnect
```http
POST /api/disconnect/{connectionId}
```

### Health Check
```http
GET /api/health
```

## 🛠 Development

### Available Scripts
- `npm run web` - Start the web server
- `npm run dev` - Start in development mode (same as web)
- `npm start` - Run original CLI version

### Server Configuration
- **Port**: 3000 (configurable via `PORT` environment variable)
- **CORS**: Enabled for cross-origin requests
- **Static Files**: Served from `/public` directory

## 🌟 Features in Detail

### Real-time Connection Monitoring
- Live connection status indicator
- Automatic question count updates
- Connection health tracking
- Automatic cleanup of inactive connections

### Enhanced User Experience
- Loading states and animations
- Clear error messaging
- Responsive design for all devices
- Graceful connection handling

### Connection Management
- Multiple simultaneous connections supported
- Automatic cleanup after 5 minutes of inactivity
- Graceful shutdown handling
- Connection persistence across page refreshes

## 🔒 Security & Performance

- **CORS Protection**: Configured for secure cross-origin requests
- **Connection Limits**: Automatic cleanup prevents memory leaks
- **Error Handling**: Comprehensive error catching and user feedback
- **Resource Management**: Efficient WebSocket connection pooling

## 🚀 Deployment Options

### Local Development
```bash
npm run web
```

### Production (PM2)
```bash
npm install -g pm2
pm2 start server.js --name "panquiz-web"
```

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
EXPOSE 3000
CMD ["npm", "run", "web"]
```

### Environment Variables
- `PORT`: Server port (default: 3000)
- `NODE_ENV`: Environment mode

## 🎯 Usage Tips

1. **Multiple Players**: You can open multiple browser tabs to simulate multiple players
2. **Mobile Friendly**: Works great on phones and tablets
3. **Real-time Updates**: Keep the tab open to see live question counts
4. **Easy Sharing**: Share `http://localhost:3000` with others on your network

## 🐛 Troubleshooting

### Common Issues

**Server won't start**
- Check if port 3000 is available
- Run `npm install` to ensure dependencies are installed

**Can't connect to games**
- Verify the Panquiz PIN is correct
- Check your internet connection
- Look at browser console for error messages

**Connection drops**
- This is normal when games end
- The interface will show disconnection status
- Simply join a new game with a fresh PIN

## 📝 Original CLI Version

To use the original command-line version:
```bash
npm start
```

## 🤝 Contributing

Feel free to improve the web interface, add new features, or enhance the user experience!

---

**Enjoy automated quiz domination! 🎯✨**