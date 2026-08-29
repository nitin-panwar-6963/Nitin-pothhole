"use client";

import { useEffect, useRef, useState } from "react";

const BACKEND_HTTP = "http://127.0.0.1:8000";
const BACKEND_WS = "ws://127.0.0.1:8000/ws/drone-stream";

export default function Home() {
  const wsRef = useRef<WebSocket | null>(null);

  const [ipCamUrl, setIpCamUrl] = useState("http://192.168.1.2:8080/video");
  const [isStreamingDrone, setIsStreamingDrone] = useState(false);
  const [droneImageSrc, setDroneImageSrc] = useState<string | null>(null);
  
  const [sessionStarted, setSessionStarted] = useState(false);
  const [sessionSeconds, setSessionSeconds] = useState(0);
  const [activePage, setActivePage] = useState("Live Detection");

  // Only these states are needed now, simplified logic!
  const [historicalLogs, setHistoricalLogs] = useState<any[]>([]);
  const [detections, setDetections] = useState<any[]>([]);
  const [detectionCount, setDetectionCount] = useState(0);
  const [criticalCount, setCriticalCount] = useState(0);
  const [highCount, setHighCount] = useState(0);
  const [mediumCount, setMediumCount] = useState(0);
  const [sessionCost, setSessionCost] = useState(0);

  const menuItems = ["Live Detection", "Detection Results", "Reports", "Cost Estimation", "Logs", "Settings"];

  useEffect(() => {
    if (!sessionStarted) return;
    const timer = setInterval(() => setSessionSeconds((prev) => prev + 1), 1000);
    return () => clearInterval(timer);
  }, [sessionStarted]);

  useEffect(() => {
    return () => stopDroneStream();
  }, []);

  const formatTime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  };

  const startDroneStream = () => {
    if (wsRef.current) wsRef.current.close();

    const socket = new WebSocket(BACKEND_WS);
    wsRef.current = socket;

    socket.onopen = () => {
      socket.send(JSON.stringify({ camera_url: ipCamUrl }));
      setIsStreamingDrone(true);
      setSessionStarted(true);
    };

    socket.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.error) {
        alert(`Error: ${data.error}`);
        stopDroneStream();
        return;
      }

      setDroneImageSrc(data.image);
      setDetections(data.detections || []); 
      
      setHistoricalLogs((prevLogs) => {
        const newLogs = [...prevLogs];
        
        (data.detections || []).forEach((det: any) => {
          if (det.id !== null && !newLogs.find(l => l.id === det.id)) {
            newLogs.push({
              id: det.id,
              confidence: det.confidence,
              width_cm: det.width_cm,
              breadth_cm: det.breadth_cm,
              depth_cm: det.depth_cm,
              cost: det.estimated_cost ?? 0,
              lat: 28.9845 + (newLogs.length * 0.0001), 
              lng: 77.7064 + (newLogs.length * 0.0001),
              severity: det.confidence >= 0.85 ? "Critical" : det.confidence >= 0.75 ? "High" : "Medium",
              time: new Date().toLocaleTimeString()
            });
          }
        });
        
        setDetectionCount(newLogs.length);
        setSessionCost(newLogs.reduce((sum, l) => sum + (l.cost || 0), 0));
        setCriticalCount(newLogs.filter(l => l.severity === "Critical").length);
        setHighCount(newLogs.filter(l => l.severity === "High").length);
        setMediumCount(newLogs.filter(l => l.severity === "Medium").length);
        
        return newLogs;
      });
    };

    socket.onerror = (err) => {
      console.error("WebSocket Error:", err);
      alert("Failed to connect to Drone Stream. Check backend terminal & IP Camera.");
      stopDroneStream();
    };

    socket.onclose = () => setIsStreamingDrone(false);
  };

  const stopDroneStream = () => {
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsStreamingDrone(false);
    setDroneImageSrc(null);
  };

  const handleBulkUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    stopDroneStream();
    alert("Uploading recorded video to server for batch processing...");

    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch(`${BACKEND_HTTP}/api/v1/analyze-video`, {
        method: "POST",
        body: formData,
      });
      const data = await response.json();

      if (response.ok) {
        alert(`Batch Analysis Complete!\nTotal Potholes: ${data.total_potholes}\nTotal Maintenance Cost: ₹${data.estimated_cost_inr}`);
        setDetectionCount(data.total_potholes);
        setCriticalCount(data.severity_breakdown.critical);
        setHighCount(data.severity_breakdown.high);
        setMediumCount(data.severity_breakdown.medium);
        setSessionCost(data.estimated_cost_inr);

        // Populate history logs with per-pothole dimensions & cost from the batch result
        const batchLogs = (data.pothole_dimensions || []).map((p: any, index: number) => ({
          id: `B${index + 1}`,
          confidence: p.confidence,
          width_cm: p.width_cm,
          breadth_cm: p.breadth_cm,
          depth_cm: p.depth_cm,
          cost: p.estimated_cost,
          lat: 28.9845 + (index * 0.0001),
          lng: 77.7064 + (index * 0.0001),
          severity: p.confidence >= 0.85 ? "Critical" : p.confidence >= 0.75 ? "High" : "Medium",
          time: new Date().toLocaleTimeString()
        }));
        setHistoricalLogs(batchLogs);
      }
    } catch (error) {
      alert("Upload failed. Ensure backend is running.");
    }
  };

  const endSession = () => {
    // Stream/session ko stop karta hai but LAST SESSION KA DATA (logs + cost) clear NAHI karta,
    // taaki maintenance cost screen par dikh sake. Data sirf "Reset Session" se clear hoga.
    stopDroneStream();
    setSessionStarted(false);
    setSessionSeconds(0);
    setDetections([]);
  };

  const resetSession = () => {
    // Poora data wipe karke fresh session ke liye taiyaar karta hai.
    stopDroneStream();
    setSessionStarted(false);
    setSessionSeconds(0);
    setDetections([]);
    setHistoricalLogs([]);
    setDetectionCount(0);
    setSessionCost(0);
    setCriticalCount(0);
    setHighCount(0);
    setMediumCount(0);
  };

  return (
    <main className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">🛡</div>
          <div>
            <h1>RoadGuard <span>AI</span></h1>
            <p>Pothole Detection System</p>
          </div>
        </div>

        <nav className="navigation">
          {menuItems.map((item) => (
            <button
              key={item}
              className={`nav-item ${activePage === item ? "active" : ""}`}
              onClick={() => setActivePage(item)}
            >
              <span className="nav-icon">
                {item === "Live Detection" && "◉"}
                {item === "Detection Results" && "▣"}
                {item === "Reports" && "▤"}
                {item === "Cost Estimation" && "₹"}
                {item === "Logs" && "◷"}
                {item === "Settings" && "⚙"}
              </span>
              {item}
            </button>
          ))}
        </nav>

        <div className="system-card">
          <div className="status-dot" style={{ background: isStreamingDrone ? '#19e68c' : '#71808b' }}></div>
          <div>
            <p>System Status</p>
            <span>{isStreamingDrone ? "Drone Feed Active" : "Ready for Inspection"}</span>
          </div>
        </div>

        <div className="operator-card">
          <div className="operator-avatar">T</div>
          <div>
            <strong>Tushar Singh</strong>
            <span>Inspection Lead</span>
          </div>
          <span className="arrow">⌄</span>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div>
            <div className="page-title-row">
              <h2>{activePage}</h2>
              <span className={`live-status ${isStreamingDrone ? 'active' : ''}`}>
                <span style={{ background: isStreamingDrone ? '#ff4d5a' : '#19e68c' }}></span>
                {isStreamingDrone ? "Drone Stream Live" : "System Standby"}
              </span>
            </div>
            <p className="subtitle">AI-powered road condition assessment & aerial inspection</p>
          </div>

          <div className="top-actions">
            <div className="time-box">
              <strong>Session {formatTime(sessionSeconds)}</strong>
              <span>Inspection Session</span>
            </div>
            <button className="end-button" onClick={endSession}>
              <span>■</span> End Session
            </button>
          </div>
        </header>

        <div className="dashboard-grid">
          {/* CAMERA */}
          <section className="camera-card">
            <div className="card-header">
              <div>
                <h3>Drone / Live Camera Stream</h3>
                <p>Real-time aerial & vehicular feed</p>
              </div>
              <div className={isStreamingDrone ? "recording active-recording" : "recording"}>
                <span></span>
                {isStreamingDrone ? "STREAMING" : "OFFLINE"}
              </div>
            </div>

            <div className="camera-screen">
              {isStreamingDrone && droneImageSrc ? (
                <img
                  src={droneImageSrc}
                  alt="Drone Live Stream"
                  className="road-video"
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                />
              ) : (
                <div className="camera-placeholder">
                  <div className="camera-icon">🛸</div>
                  <h3>Drone IP Camera Standby</h3>
                  <p>Enter your phone IP Webcam URL & initialize stream</p>
                  
                  <div style={{ margin: "12px 0", width: "80%", maxWidth: "360px" }}>
                    <input
                      type="text"
                      value={ipCamUrl}
                      onChange={(e) => setIpCamUrl(e.target.value)}
                      placeholder="http://192.168.1.X:8080/video"
                      style={{
                        width: "100%",
                        padding: "8px 12px",
                        borderRadius: "6px",
                        background: "#0d1b2a",
                        border: "1px solid #1f3a56",
                        color: "#fff",
                        fontSize: "0.85rem",
                        textAlign: "center"
                      }}
                    />
                  </div>

                  <div className="camera-buttons">
                    <button className="start-button" onClick={startDroneStream}>
                      📡 Connect Drone Feed
                    </button>
                    <label className="upload-button" style={{ borderColor: "#b38cff", color: "#b38cff" }}>
                      ☁️ Server Bulk Analyze
                      <input type="file" accept="video/*" onChange={handleBulkUpload} hidden />
                    </label>
                  </div>
                </div>
              )}
            </div>

            {isStreamingDrone && (
              <div className="video-controls">
                <button className="stop-camera" onClick={stopDroneStream}>
                  ■ Disconnect Drone
                </button>
                <label className="upload-button" style={{ borderColor: "#b38cff", color: "#b38cff", marginLeft: "auto" }}>
                  ☁️ Server Bulk Analyze
                  <input type="file" accept="video/*" onChange={handleBulkUpload} hidden />
                </label>
              </div>
            )}
          </section>

          {/* SUMMARY */}
          <section className="summary-card">
            <div className="card-header">
              <div>
                <h3>Detection Summary</h3>
                <p>Live PWD metrics</p>
              </div>
              <span className="total-detected">Total: {detectionCount}</span>
            </div>
            <div className="severity-grid">
              <div className="severity critical">
                <span className="severity-icon">!</span>
                <strong>{criticalCount}</strong>
                <p>Critical</p>
              </div>
              <div className="severity high">
                <span className="severity-icon">!</span>
                <strong>{highCount}</strong>
                <p>High</p>
              </div>
              <div className="severity medium">
                <span className="severity-icon">!</span>
                <strong>{mediumCount}</strong>
                <p>Medium</p>
              </div>
            </div>
          </section>

          {/* HISTORY LOGS */}
          <section className="detections-card">
            <div className="card-header">
              <div>
                <h3>Detection History Logs</h3>
                <p>Persistent AI verified defects</p>
              </div>
            </div>
            {historicalLogs.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">◉</div>
                <h3>No Defects Logged</h3>
              </div>
            ) : (
              <div className="detection-list" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                {historicalLogs.map((log, index) => (
                  <div className="detection-item" key={index}>
                    <div className="detection-info">
                      <strong>Pothole ID: #{log.id}</strong>
                      <span>Detected at: {log.time}</span>
                    </div>
                    <div className="detection-details">
                      <span className={`severity ${log.severity.toLowerCase()}`}>{log.severity}</span>
                      {log.width_cm !== undefined && (
                        <span>📐 {log.width_cm}×{log.breadth_cm}×{log.depth_cm} cm (W×B×D)</span>
                      )}
                      {isStreamingDrone ? (
                        <span style={{ opacity: 0.6 }}>🔒 cost pending</span>
                      ) : (
                        <span>₹{log.cost}</span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* TELEMETRY MAP (Using History) */}
          <section className="detections-card">
            <div className="card-header">
              <div>
                <h3>Telemetry & GPS Coordinates</h3>
                <p>Geotagged pothole locations</p>
              </div>
            </div>
            {historicalLogs.length === 0 ? (
              <div className="empty-state">
                <div className="empty-icon">📍</div>
                <h3>No GPS Tags Logged</h3>
              </div>
            ) : (
              <div className="detection-list" style={{ maxHeight: '300px', overflowY: 'auto' }}>
                {historicalLogs.map((log, index) => (
                  <div className="detection-item" key={index}>
                    <div className="detection-info">
                      <strong>Pothole ID: #{log.id}</strong>
                      <span>📍 {log.lat.toFixed(5)}, {log.lng.toFixed(5)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* COST */}
          <section className="cost-card">
            <div className="card-header">
              <div>
                <h3>Estimated Maintenance Cost</h3>
                <p>Based on detected width, breadth & depth</p>
              </div>
              <span className="cost-icon">₹</span>
            </div>

            {isStreamingDrone ? (
              <div className="empty-state">
                <div className="empty-icon">🔒</div>
                <h3>Cost Hidden While Live</h3>
                <p>Maintenance cost will appear here once the stream is stopped or disconnected.</p>
              </div>
            ) : historicalLogs.length > 0 ? (
              <>
                <div className="cost-value">₹{sessionCost.toLocaleString("en-IN")}</div>
                <div className="cost-footer">
                  <span>Total Maintenance Cost — Last Session</span>
                  <span>{detectionCount} identified defects</span>
                </div>
              </>
            ) : (
              <div className="empty-state">
                <div className="empty-icon">₹</div>
                <h3>No Session Data Yet</h3>
                <p>Start & stop a stream (or run bulk analysis) to see maintenance cost here.</p>
              </div>
            )}
          </section>

          {/* CONTROLS */}
          <section className="session-card">
            <div className="card-header">
              <div>
                <h3>Session Controls</h3>
                <p>Data export and verification</p>
              </div>
            </div>
            <div className="session-actions">
              <button><span>▣</span> Export Geotags</button>
              <button><span>▤</span> Generate PWD Report</button>
              <button onClick={resetSession}><span>↓</span> Reset Session</button>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}