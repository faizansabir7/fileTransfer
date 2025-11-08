# 🚀 Local File Share

A web-based application for sharing large files between devices on the same local network or hotspot **without requiring internet connection**. Works on both PC and mobile devices with a responsive design.

## ✨ Features

- 📱 **Cross-Platform**: Works on PC, mobile, and tablets
- 🌐 **No Internet Required**: Operates entirely on local network
- 🔗 **Easy Connection**: Share via URL or QR code
- 📁 **Large File Support**: Share files of any size
- 🎯 **Drag & Drop**: Simple file selection interface
- 📊 **Progress Tracking**: Real-time download progress
- 🔒 **Secure**: Files stay on your local network
- ⚡ **Fast Transfer**: Direct peer-to-peer transfer

## 🚀 Quick Start

### Method 1: Python Server (Recommended)

1. **Start the server:**
   ```bash
   python3 server.py
   ```

2. **Access the application:**
   - Open your browser and go to the displayed Network URL
   - Example: `http://192.168.1.100:8080`

3. **Share with other devices:**
   - Copy the Network URL to other devices on the same network
   - Or scan the QR code with mobile devices

### Method 2: Static Files

1. **Serve using any HTTP server:**
   ```bash
   # Using Python's built-in server
   python3 -m http.server 8080
   
   # Using Node.js
   npx serve .
   
   # Using PHP
   php -S localhost:8080
   ```

2. **Access via your local IP:**
   - Find your local IP address
   - Access `http://YOUR_LOCAL_IP:8080` from any device

## 📱 How to Use

### Host Mode (Share Files)
1. Click **"Host Files"** button
2. Drag and drop files or click to select
3. Share the displayed URL with other devices
4. Other devices can download your files

### Client Mode (Receive Files)
1. Click **"Connect to Host"** button
2. Enter the host URL or scan QR code
3. Browse and download available files
4. Track download progress in real-time

## 🌐 Network Setup Options

### Option 1: Same WiFi Network
- Connect all devices to the same WiFi network
- Use the Network URL shown by the server

### Option 2: Mobile Hotspot
1. **Enable hotspot** on one device (Android/iPhone)
2. **Connect other devices** to the hotspot
3. **Run the server** on the hotspot device
4. **Access the app** from connected devices

### Option 3: Ethernet Network
- Connect devices via ethernet switch/router
- Use the Network URL for local access

## 🔧 Technical Details

### Browser Compatibility
- ✅ Chrome/Chromium (Mobile & Desktop)
- ✅ Firefox (Mobile & Desktop)
- ✅ Safari (Mobile & Desktop)
- ✅ Edge (Desktop)

### File Transfer Technology
- **WebRTC** for peer-to-peer communication
- **HTTP** for reliable file serving
- **Progressive Web App** for mobile experience

### Security Features
- Local network only (no data leaves your network)
- No external servers involved
- No file storage on remote servers

## 📂 File Structure

```
local-file-share/
├── index.html          # Main application interface
├── style.css           # Responsive styling
├── script.js           # Application logic
├── server.py           # Python HTTP server
├── manifest.json       # PWA manifest
├── sw.js              # Service worker for offline support
└── README.md          # This file
```

## 🛠️ Customization

### Changing Server Port
Edit `server.py` and modify the `start_port` parameter:
```python
server_port = get_available_port(8080)  # Change 8080 to your desired port
```

### Styling
Modify `style.css` to customize the appearance:
- Colors: Update CSS variables
- Layout: Modify responsive breakpoints
- Animations: Adjust transition timings

### Features
Extend `script.js` to add new features:
- File type restrictions
- User authentication
- Chat functionality
- File encryption

## 🔍 Troubleshooting

### Connection Issues
- Ensure all devices are on the same network
- Check firewall settings
- Verify the server is running
- Try using the local IP address directly

### File Transfer Problems
- Check available storage space
- Ensure stable network connection
- Try smaller files first
- Restart the server if needed

### Mobile Issues
- Enable JavaScript in browser
- Allow camera access for QR scanning
- Use landscape mode for better experience
- Clear browser cache if needed

## 📋 Requirements

- **Python 3.6+** (for the server)
- **Modern web browser** with JavaScript enabled
- **Local network** or **mobile hotspot**
- **Camera access** (optional, for QR code scanning)

## 🤝 Contributing

Feel free to submit issues and enhancement requests!

## 📄 License

This project is open source and available under the MIT License.

## 🆘 Support

For issues or questions:
1. Check the troubleshooting section
2. Ensure your network setup is correct
3. Verify browser compatibility
4. Try restarting the server

---

**Happy File Sharing! 🎉**