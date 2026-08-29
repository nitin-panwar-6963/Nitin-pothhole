import cv2
import numpy as np
import os
import shutil
import uuid
import base64
import asyncio
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO

app = FastAPI(title="RoadGuard AI Backend", version="1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

print("Loading YOLOv11 Model...")
model = YOLO("pothole_best.pt")

os.makedirs("temp_uploads", exist_ok=True)

DRONE_IP_CAM_URL = "http://192.168.1.2:8080/video"

# MAINTENANCE COST ESTIMATION MANAGEMENT

# YOLO confidence se heuristically estimate kar rahe hain (bada aur zyada
# confident detection = zyada gehra gaddha, generally true in practice).
# Width/Breadth bounding box ke pixel size ko real-world cm me convert karke
# nikal rahe hain. CM_PER_PIXEL ko apni drone/camera ki altitude/calibration
# ke hisaab se tune kar sakte ho.
CM_PER_PIXEL = 0.4          # 1 pixel ≈ 0.4 cm on ground (adjust as per camera calibration)
MIN_DEPTH_CM = 3.0
MAX_DEPTH_CM = 25.0
COST_PER_CUBIC_METER_INR = 8500   # PWD-style asphalt/premix patching material rate (₹/m³)
FIXED_LABOR_COST_INR = 150        # Fixed mobilization + labor cost per pothole


def estimate_pothole_dimensions(x1: float, y1: float, x2: float, y2: float, conf: float):
    """Bounding box + confidence se width, breadth (cm) aur depth (cm) estimate karta hai."""
    width_px = max(1.0, x2 - x1)
    breadth_px = max(1.0, y2 - y1)

    width_cm = round(width_px * CM_PER_PIXEL, 1)
    breadth_cm = round(breadth_px * CM_PER_PIXEL, 1)

    # Depth heuristic: bigger area + higher confidence -> deeper pothole
    area_px = width_px * breadth_px
    depth_cm = 3.0 + (conf ** 2) * 15.0 + (area_px / 6000.0)
    depth_cm = round(min(MAX_DEPTH_CM, max(MIN_DEPTH_CM, depth_cm)), 1)

    return width_cm, breadth_cm, depth_cm


def calculate_maintenance_cost(width_cm: float, breadth_cm: float, depth_cm: float):
    """Volume (m³) nikal ke usse material + labor cost calculate karta hai."""
    volume_m3 = (width_cm / 100.0) * (breadth_cm / 100.0) * (depth_cm / 100.0)
    material_cost = volume_m3 * COST_PER_CUBIC_METER_INR
    total_cost = round(FIXED_LABOR_COST_INR + material_cost)
    return total_cost, round(volume_m3, 5)

@app.get("/health")
def health_check():
    return {"backend": "Active", "model": "YOLOv11 Loaded"}

# WEBSOCKET FOR REAL-TIME DRONE IP STREAM
@app.websocket("/ws/drone-stream")
async def drone_stream_websocket(websocket: WebSocket):
    await websocket.accept()
    
    try:
        init_data = await asyncio.wait_for(websocket.receive_json(), timeout=2.0)
        camera_url = init_data.get("camera_url", DRONE_IP_CAM_URL)
    except Exception:
        camera_url = DRONE_IP_CAM_URL

    #for usb connection-> 
    if str(camera_url).isdigit(): # agar 0/1 mein input jayega to opencv samajh jayega ki video input wifi se nahi balki usb se aa rha hai and vo wifi video streaming ko bypass kar dega
        camera_url = int(camera_url)

    print(f"Connecting to Drone Camera Stream at: {camera_url}")
    cap = cv2.VideoCapture(camera_url)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # Tries to keep only the freshest frame
    # 
    if not cap.isOpened():
        await websocket.send_json({"error": "Failed to connect to IP Camera stream."})
        await websocket.close()
        return

    # Session-level tracker: track_id -> maintenance cost, so ki same pothole
    # ko baar baar frames me count/cost na ho (sirf unique gaddho ka total).
    session_pothole_costs = {}

    try:
        while True:
            success, frame = cap.read()
            if not success:
                await asyncio.sleep(0.05)
                continue

            # NEW: Resize immediately to drop processing load
            #frame = cv2.resize(frame, (640, 480))

            # Run YOLO...
            results = model.track(frame, tracker="bytetrack.yaml", persist=True, conf=0.60, verbose=False)
            annotated_frame = results[0].plot()

            detections = []
            critical, high, medium = 0, 0, 0
            boxes = results[0].boxes
            if boxes is not None:
                for box in boxes:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    conf = float(box.conf[0])
                    
                    # EXTRACT UNIQUE TRACKING ID
                    track_id = int(box.id[0]) if box.id is not None else None
                    
                    if conf >= 0.85:
                        critical += 1
                    elif conf >= 0.75:
                        high += 1
                    else:
                        medium += 1

                    # Depth/Width/Breadth -> maintenance cost estimation
                    width_cm, breadth_cm, depth_cm = estimate_pothole_dimensions(x1, y1, x2, y2, conf)
                    pothole_cost, volume_m3 = calculate_maintenance_cost(width_cm, breadth_cm, depth_cm)

                    if track_id is not None:
                        session_pothole_costs[track_id] = pothole_cost

                    detections.append({
                        "id": track_id, # Sending ID to frontend
                        "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                        "confidence": conf,
                        "width_cm": width_cm,
                        "breadth_cm": breadth_cm,
                        "depth_cm": depth_cm,
                        "volume_m3": volume_m3,
                        "estimated_cost": pothole_cost
                    })

            # NEW: Drop JPEG quality to 40 for much faster WebSocket streaming
            _, buffer = cv2.imencode(".jpg", annotated_frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
            base64_frame = base64.b64encode(buffer).decode("utf-8")

            session_total_cost = sum(session_pothole_costs.values())

            payload = {
                "image": f"data:image/jpeg;base64,{base64_frame}",
                "count": len(detections),
                "critical": critical,
                "high": high,
                "medium": medium,
                "estimated_cost": len(detections) * 250,  # legacy quick estimate (kept for compat)
                "session_total_maintenance_cost": session_total_cost,
                "session_unique_potholes": len(session_pothole_costs),
                "detections": detections
            }

            await websocket.send_json(payload)
            await asyncio.sleep(0.005) 

    except WebSocketDisconnect:
        print("Frontend disconnected from Drone Stream.")
    except Exception as e:
        print(f"Stream error: {e}")
    finally:
        cap.release()
        total = sum(session_pothole_costs.values())
        print(f"Session ended. Unique potholes: {len(session_pothole_costs)} | Total maintenance cost: ₹{total}")

# --- BATCH UPLOAD FOR LARGE 100MB+ RECORDED VIDEOS ---
@app.post("/api/v1/analyze-video")
async def analyze_video(file: UploadFile = File(...)):
    file_ext = file.filename.split('.')[-1]
    unique_filename = f"{uuid.uuid4()}.{file_ext}"
    file_path = f"temp_uploads/{unique_filename}"
    
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    cap = cv2.VideoCapture(file_path)
    fps = cap.get(cv2.CAP_PROP_FPS) or 30
    frame_skip = int(fps)
    
    total_potholes = 0
    critical, high, medium = 0, 0, 0
    frame_count = 0
    total_maintenance_cost = 0
    pothole_dimensions = []  # per-detection width/breadth/depth/cost for frontend display
    
    while cap.isOpened():
        success, frame = cap.read()
        if not success:
            break
            
        if frame_count % frame_skip == 0:
            # FIXED: conf=0.60 added to block garbage detections
            results = model(frame, conf=0.60, verbose=False)
            if results[0].boxes:
                for box in results[0].boxes:
                    total_potholes += 1
                    conf = float(box.conf[0])
                    
                    if conf >= 0.85: critical += 1
                    elif conf >= 0.75: high += 1
                    else: medium += 1

                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    width_cm, breadth_cm, depth_cm = estimate_pothole_dimensions(x1, y1, x2, y2, conf)
                    pothole_cost, volume_m3 = calculate_maintenance_cost(width_cm, breadth_cm, depth_cm)
                    total_maintenance_cost += pothole_cost

                    pothole_dimensions.append({
                        "frame": frame_count,
                        "confidence": conf,
                        "width_cm": width_cm,
                        "breadth_cm": breadth_cm,
                        "depth_cm": depth_cm,
                        "volume_m3": volume_m3,
                        "estimated_cost": pothole_cost
                    })
                    
        frame_count += 1
        
    cap.release()
    os.remove(file_path)
    
    return {
        "status": "success",
        "total_frames_analyzed": frame_count // frame_skip,
        "total_potholes": total_potholes,
        "severity_breakdown": {"critical": critical, "high": high, "medium": medium},
        "estimated_cost_inr": total_maintenance_cost,
        "pothole_dimensions": pothole_dimensions
    }
