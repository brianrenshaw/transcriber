// swift-tools-version:5.9
// transcriber-speech: the speech engines the app carries inside it, so nothing else needs installing.
// Parakeet and the speaker separation come from FluidAudio, Whisper from WhisperKit; both run on Core ML.
import PackageDescription

let package = Package(
  name: "transcriber-speech",
  platforms: [.macOS(.v14)],
  dependencies: [
    .package(url: "https://github.com/argmaxinc/WhisperKit.git", exact: "1.1.1"),
    .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.18.2"),
  ],
  targets: [
    .executableTarget(name: "transcriber-speech", dependencies: [
      .product(name: "WhisperKit", package: "WhisperKit"),
      .product(name: "FluidAudio", package: "FluidAudio"),
    ]),
  ]
)
