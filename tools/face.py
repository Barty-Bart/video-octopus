# Usage: python face.py <image> [image…]  →  JSON: [[{"x","y","w","h"} faces of image 1, top-left origin, 0–1], …]
# The Windows/Linux stand-in for face.swift (macOS Vision): OpenCV 4's frontal-face cascade (pip install
# "opencv-python<5"; OpenCV 5 moved the cascades out of the main package).
import json, sys
import cv2

if not hasattr(cv2, 'CascadeClassifier'):
    sys.exit('No face detector: this OpenCV has no CascadeClassifier (it needs OpenCV 4: pip install "opencv-python<5").')
cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
out = []
for path in sys.argv[1:]:
    img = cv2.imread(path)
    if img is None:
        out.append([])
        continue
    H, W = img.shape[:2]
    gray = cv2.equalizeHist(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY))
    faces = cascade.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(max(24, W // 20), max(24, W // 20)))
    out.append([{'x': x / W, 'y': y / H, 'w': w / W, 'h': h / H} for (x, y, w, h) in faces])
print(json.dumps(out))
