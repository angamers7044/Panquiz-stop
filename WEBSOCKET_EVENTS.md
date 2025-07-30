# 🔗 WebSocket Medal Detection Guide

## How Panquiz Medals Work via WebSocket

The medals are sent through the **same SignalR WebSocket connection** that handles the game, but they come as **additional events** after the quiz ends.

## 📡 WebSocket Event Flow

### 1. **Game Start Events**
```
{} (handshake)
PlayerJoined -> Join the game
ShowQuestion -> Each question + auto-answer
```

### 2. **Game End Events** ⭐ *This is where medals come!*
```
PlayerDisconnected -> Game ending signal
🏅 POTENTIAL MEDAL EVENTS:
- GameResults
- PlayerStats  
- Achievements
- LeaderBoard
- FinalScore
- QuizComplete
- MatchSummary
```

## 🔍 What to Look For in Logs

After deploying to Render, monitor your logs for:

### **Medal Events** 🏅
```
🏅 2024-01-15T10:30:45.123Z - [PlayerName] MEDAL/RESULTS EVENT: GameResults
🏅 2024-01-15T10:30:45.124Z - [PlayerName] DATA: {
  "medals": [...],
  "score": 1000,
  "achievements": [...]
}
```

### **Unknown Events** 🔍
```
🔍 2024-01-15T10:30:46.125Z - [PlayerName] NEW EVENT: PlayerStats
🔍 2024-01-15T10:30:46.126Z - [PlayerName] ARGS: {
  "stats": {...},
  "rankings": {...}
}
```

## ⚡ Key Changes Made

### 1. **Extended Connection Time**
- WebSocket stays open **10 seconds** after `PlayerDisconnected`
- Gives time to capture medal events that come after game ends

### 2. **Enhanced WebSocket Logging**
- **ALL messages** are logged with timestamps
- **Raw WebSocket data** and **parsed JSON** both captured
- **Production-ready** logging for Render

### 3. **Medal Storage**
- Medal events are **stored in memory**
- Accessible via `/api/medals/{connectionId}` endpoint
- **Timestamped** for analysis

## 🎯 Testing Process

1. **Deploy to Render** with enhanced logging
2. **Join a Panquiz game** via your web interface  
3. **Complete the entire quiz** (don't leave early!)
4. **Wait for game to end** naturally
5. **Check Render logs immediately** after completion
6. **Look for new WebSocket events** in the 10-second window

## 🚀 Expected Medal WebSocket Events

Based on typical quiz platforms, expect events like:

```javascript
// Game completion with medals
{
  "type": 1,
  "target": "GameResults",
  "arguments": [{
    "medals": [
      { "type": "perfect_score", "name": "Perfect Game" },
      { "type": "speed_demon", "name": "Lightning Fast" }
    ],
    "finalScore": 1000,
    "ranking": 1,
    "totalPlayers": 10
  }]
}

// Achievement notification
{
  "type": 1, 
  "target": "AchievementUnlocked",
  "arguments": [{
    "achievementId": "first_win",
    "title": "First Victory",
    "description": "Win your first game"
  }]
}
```

## 🏅 Medal Event Patterns

Look for WebSocket events containing:
- **Medal objects** with names/descriptions
- **Achievement data** with unlock conditions  
- **Score breakdowns** with bonus points
- **Ranking information** with player positions
- **Statistics** with performance metrics

Your bot will now capture **everything** that comes through the WebSocket! 🎯