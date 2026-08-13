import Vision
import AppKit

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
guard let img = NSImage(contentsOfFile: path) else { print("__ERR__ load"); exit(1) }
var rect = NSRect(origin: .zero, size: img.size)
guard let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil) else { print("__ERR__ cg"); exit(1) }
let req = VNRecognizeTextRequest { request, _ in
    let obs = request.results as? [VNRecognizedTextObservation] ?? []
    for o in obs {
        if let t = o.topCandidates(1).first { print(t.string) }
    }
}
req.recognitionLevel = .accurate
req.recognitionLanguages = ["zh-Hans", "en-US"]
req.usesLanguageCorrection = true
let handler = VNImageRequestHandler(cgImage: cg, options: [:])
try? handler.perform([req])
