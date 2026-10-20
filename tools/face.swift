// Finds faces in still images with macOS Vision. Video Octopus uses it to frame the camera around the head.
// Usage: face <image> [image…]  →  JSON: [[{"x","y","w","h"} faces of image 1, top-left origin, 0–1], …]
import AppKit
import Vision

var out: [[[String: Double]]] = []
for path in CommandLine.arguments.dropFirst() {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { out.append([]); continue }
    let req = VNDetectFaceRectanglesRequest()
    try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([req])
    out.append((req.results ?? []).map { f in
        let b = f.boundingBox
        return ["x": Double(b.minX), "y": Double(1 - b.maxY), "w": Double(b.width), "h": Double(b.height)]
    })
}
let data = try! JSONSerialization.data(withJSONObject: out)
print(String(data: data, encoding: .utf8)!)
