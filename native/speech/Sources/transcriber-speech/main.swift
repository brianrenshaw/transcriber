// transcriber-speech: the speech engines the app carries inside it, run as a separate process.
//
//   transcriber-speech parakeet --models <dir> [--speakers [--speaker-count N]] [--vocab <vocab.json>] <audio> <out.json>
//   transcriber-speech whisper  --models <dir> [--vocab <vocab.json>] <audio> <out.json>
//
// The app downloads the models into <dir> and checks every file against the list it carries (src/main/models.js);
// this helper only loads them, and never downloads anything.
//
// vocab.json is your word list as the engines take it: {"prompt": "Keller, Joyce.", "terms": [{"text",
// "aliases"}]}. Whisper reads the prompt as though it were the text just before; Parakeet's words are rescored
// against the terms (FluidAudio's CTC keyword boosting, with a small second model).
//
// The output is the JSON MacWhisper's CLI writes, so the app reads both the same way:
//   {"segments": [{"start", "end", "text", "words": [{"start", "end", "text"}], "speaker"?}], "text"}
// with times in milliseconds and a new word's text beginning with a space. One voice gets no speaker labels.
// Progress goes to stdout as JSON lines, {"what": "Whisper", "progress": 0.42}; errors go to stderr with exit 1.
//
// Parakeet TDT v3 and the speaker separation (pyannote segmentation, WeSpeaker embeddings, VBx clustering) come
// from FluidAudio; Whisper large-v3 turbo from WhisperKit. All of it runs on Core ML, on this Mac.

import Foundation
import FluidAudio
import WhisperKit

let whisperVariant = "openai_whisper-large-v3-v20240930_626MB"

// FluidAudio fetches a model from Hugging Face's main branch, unchecked, whenever it finds a file missing. Its
// registry points at a name that cannot resolve, so a missing file fails the job instead of being fetched.
ModelRegistry.baseURL = "https://models-come-from-the-app.invalid"

struct Word: Codable { var start: Int; var end: Int; var text: String }
struct Segment: Codable { var start: Int; var end: Int; var text: String; var words: [Word]; var speaker: String? }
struct Output: Codable { var segments: [Segment]; var text: String }
struct VocabTerm: Codable { var text: String; var aliases: [String]? }
struct Vocab: Codable { var prompt: String?; var terms: [VocabTerm]? }

func emit(_ what: String, _ progress: Double) {
  let p = (max(0, min(1, progress)) * 1000).rounded() / 1000
  print("{\"what\":\"\(what)\",\"progress\":\(p)}")
  fflush(stdout)
}

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data((message + "\n").utf8))
  exit(1)
}

func ms(_ seconds: Double) -> Int { Int((seconds * 1000).rounded()) }

// ---------------------------------------------------------------- arguments

var command = ""
var modelsDir: URL?
var speakers = false
var speakerCount: Int?
var vocabFile: URL?
var positional: [String] = []
var rest = CommandLine.arguments.dropFirst().makeIterator()
while let a = rest.next() {
  switch a {
  case "--models":
    guard let v = rest.next() else { fail("--models needs a folder") }
    modelsDir = URL(fileURLWithPath: v, isDirectory: true)
  case "--speakers": speakers = true
  case "--speaker-count": speakerCount = rest.next().flatMap { Int($0) }
  case "--vocab": vocabFile = rest.next().map { URL(fileURLWithPath: $0) }
  default: if command.isEmpty { command = a } else { positional.append(a) }
  }
}
guard let models = modelsDir else { fail("usage: transcriber-speech parakeet|whisper --models <dir> [--speakers] <audio> <out.json>") }

// Where the app puts each model (the `to` folders in src/main/models.json). FluidAudio finds Parakeet and the
// CTC model beside the folder it is given, under the model's own name.
let parakeetDir = models.appendingPathComponent("parakeet", isDirectory: true)
let speakersDir = models.appendingPathComponent("speakers", isDirectory: true)
let whisperDir = models.appendingPathComponent("whisper", isDirectory: true).appendingPathComponent(whisperVariant, isDirectory: true)
let tokenizerDir = models.appendingPathComponent("whisper", isDirectory: true).appendingPathComponent("tokenizer", isDirectory: true)
let ctcDir = models.appendingPathComponent("ctc", isDirectory: true).appendingPathComponent("parakeet-ctc-110m-coreml", isDirectory: true)

let vocab: Vocab? = vocabFile.flatMap { try? Data(contentsOf: $0) }.flatMap { try? JSONDecoder().decode(Vocab.self, from: $0) }

func warn(_ message: String) { FileHandle.standardError.write(Data(("warning: " + message + "\n").utf8)) }

func present(_ dirs: URL...) -> Bool { dirs.allSatisfy { FileManager.default.fileExists(atPath: $0.path) } }

func write(_ segments: [Segment], to out: URL) throws {
  let text = segments.map(\.text).joined(separator: " ")
  let enc = JSONEncoder()
  enc.outputFormatting = [.withoutEscapingSlashes]
  try FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
  try enc.encode(Output(segments: segments, text: text)).write(to: out, options: .atomic)
}

// ---------------------------------------------------------------- Parakeet

// SentencePiece pieces into words: a piece that starts with the word boundary begins a word, any other piece
// (a suffix, a comma) joins the word before it. Before a number the boundary comes as a piece of its own, then
// one piece per digit; it still begins a word, or "the 2026" would read "the2026".
func words(from tokens: [TokenTiming]) -> [Word] {
  var out: [Word] = []
  var boundary = false
  for t in tokens {
    let raw = t.token.replacingOccurrences(of: "\u{2581}", with: " ")
    if raw.hasPrefix("<") && raw.hasSuffix(">") { continue }
    let piece = raw.trimmingCharacters(in: .whitespaces)
    if piece.isEmpty { if raw.hasPrefix(" ") { boundary = true }; continue }
    if raw.hasPrefix(" ") || boundary || out.isEmpty {
      out.append(Word(start: ms(t.startTime), end: ms(t.endTime), text: " " + piece))
    } else {
      out[out.count - 1].text += piece
      out[out.count - 1].end = ms(t.endTime)
    }
    boundary = false
  }
  return out
}

// Each word takes the turn it overlaps most (the longer turn on a tie), or the nearest one in a gap.
func label(_ words: [Word], with turns: [TimedSpeakerSegment]) -> [String?] {
  let sorted = turns.sorted { $0.startTimeSeconds < $1.startTimeSeconds }
  guard !sorted.isEmpty else { return words.map { _ in nil } }
  var j = 0
  return words.map { w in
    let a = Float(w.start) / 1000, b = Float(w.end) / 1000, mid = (a + b) / 2
    while j + 1 < sorted.count && sorted[j + 1].startTimeSeconds <= mid { j += 1 }
    let score = { (t: TimedSpeakerSegment) -> (Float, Float) in
      let overlap = min(b, t.endTimeSeconds) - max(a, t.startTimeSeconds)
      let gap = mid < t.startTimeSeconds ? t.startTimeSeconds - mid : mid - t.endTimeSeconds
      return (overlap > 0 ? overlap : -max(0, gap), t.endTimeSeconds - t.startTimeSeconds)
    }
    return sorted[max(0, j - 2)...min(sorted.count - 1, j + 1)].max { score($0) < score($1) }?.speakerId
  }
}

// Segments as a transcript reads: a new one after a sentence ends, at a long pause, or after 40 words, then
// split where the voice changes. A change of voice for under five words inside a sentence is the separation's
// mistake (a moment of overlap, a sting of music), so those words keep the voice around them. Voices are then
// named Speaker 1, Speaker 2 in the order they speak; one voice gets no labels, as MacWhisper does.
func segments(_ words: [Word], _ labels: [String?]) -> [Segment] {
  var spans: [Range<Int>] = []
  var start = 0
  for i in words.indices.dropFirst() {
    let last = words[i - 1]
    let sentence = last.text.range(of: "[.?!][\"”’)]*$", options: .regularExpression) != nil
    if words[i].start - last.end > 1500 || (sentence && i - start >= 4) || i - start >= 40 { spans.append(start..<i); start = i }
  }
  if start < words.count { spans.append(start..<words.count) }

  var parts: [(who: String?, r: Range<Int>)] = []
  for span in spans {
    var runs: [(who: String?, r: Range<Int>)] = []
    for i in span {
      if let last = runs.last, last.who == labels[i] { runs[runs.count - 1].r = last.r.lowerBound..<(i + 1) }
      else { runs.append((labels[i], i..<(i + 1))) }
    }
    while runs.count > 1, let k = runs.indices.filter({ runs[$0].r.count < 5 }).min(by: { runs[$0].r.count < runs[$1].r.count }) {
      let n = [k - 1, k + 1].filter { runs.indices.contains($0) }.max { runs[$0].r.count < runs[$1].r.count }!
      runs[n].r = min(runs[k].r.lowerBound, runs[n].r.lowerBound)..<max(runs[k].r.upperBound, runs[n].r.upperBound)
      runs.remove(at: k)
      var m = 1
      while m < runs.count {
        if runs[m].who == runs[m - 1].who { runs[m - 1].r = runs[m - 1].r.lowerBound..<runs[m].r.upperBound; runs.remove(at: m) } else { m += 1 }
      }
    }
    parts += runs
  }

  var names: [String: String] = [:]
  for p in parts { if let id = p.who, names[id] == nil { names[id] = "Speaker \(names.count + 1)" } }
  let named = names.count >= 2
  return parts.map { p in
    let ws = Array(words[p.r])
    return Segment(start: ws.first!.start, end: ws.last!.end, text: ws.map(\.text).joined().trimmingCharacters(in: .whitespaces),
      words: ws, speaker: named ? p.who.flatMap { names[$0] } : nil)
  }
}

// The word list's terms, rescored against what Parakeet heard. A word is replaced only where a term is spelled
// much like it and the audio fits the term better (FluidAudio's CTC keyword spotter, a second, small model).
// Boosting must never cost the transcript, so any failure leaves Parakeet's words as they were.
func boost(_ ws: [Word], _ result: ASRResult, _ samples: [Float], _ terms: [VocabTerm]) async -> [Word] {
  guard let timings = result.tokenTimings, !timings.isEmpty, !terms.isEmpty else { return ws }
  do {
    let ctc = try await CtcModels.downloadAndLoad(to: ctcDir, variant: .ctc110m)
    let tokenizer = try await CtcTokenizer.load(from: ctcDir)
    let list = terms.compactMap { t -> CustomVocabularyTerm? in
      let ids = tokenizer.encode(t.text)
      guard !ids.isEmpty else { return nil }
      let aliases = (t.aliases ?? []).filter { !$0.isEmpty }
      return CustomVocabularyTerm(text: t.text, aliases: aliases.isEmpty ? nil : aliases, ctcTokenIds: ids)
    }
    guard !list.isEmpty else { return ws }
    let context = CustomVocabularyContext(terms: list)
    let spotter = CtcKeywordSpotter(models: ctc, blankId: ctc.vocabulary.count)
    // FluidAudio's default lets the audio alone put a term in place of any word ("Delgado" became "Keller"
    // on a real recording, 150 times). Only words already spelled like a term may change, and short terms get
    // less of a boost.
    let config = VocabularyRescorer.Config(shortTermCbwTaperPivot: 5, spotterRescueMinSimilarity: 0.5,
      spotterRescueMultiWordMinSimilarity: 0.6, spotterRescueEnabled: false)
    let rescorer = try await VocabularyRescorer.create(spotter: spotter, vocabulary: context, config: config, ctcModelDirectory: ctcDir)
    let spot = try await spotter.spotKeywordsWithLogProbs(audioSamples: samples, customVocabulary: context, minScore: nil)
    guard !spot.logProbs.isEmpty else { return ws }
    let size = ContextBiasingConstants.rescorerConfig(forVocabSize: list.count)
    let out = rescorer.ctcTokenRescore(transcript: result.text, tokenTimings: timings, logProbs: spot.logProbs,
      frameDuration: spot.frameDuration, cbw: size.cbw, marginSeconds: VocabularyBoostingSession.Thresholds.default.marginSeconds,
      minSimilarity: max(size.minSimilarity, context.minSimilarity))
    guard out.wasModified else { return ws }
    return apply(out.text, to: ws, terms: terms)
  } catch {
    warn("the word list could not be applied: \(error.localizedDescription)")
    return ws
  }
}

// The rescored text back onto the timed words. The rescorer builds its words from the same pieces, so most
// replacements are one word for one; where a term covers more or fewer words, the new words share the old
// ones' time. Words are matched on their letters, and a replaced word keeps the punctuation it had. A change
// stands only when it writes a term and the words it replaces are spelled close to that term or a form it is
// heard as; anything else keeps Parakeet's words.
func similarity(_ a: String, _ b: String) -> Double {
  let x = Array(a), y = Array(b)
  if x.isEmpty || y.isEmpty { return 0 }
  var row = Array(0...y.count)
  for i in 1...x.count {
    var prev = row[0]; row[0] = i
    for j in 1...y.count {
      let cur = row[j]
      row[j] = min(row[j] + 1, row[j - 1] + 1, prev + (x[i - 1] == y[j - 1] ? 0 : 1))
      prev = cur
    }
  }
  return 1 - Double(row[y.count]) / Double(max(x.count, y.count))
}

func apply(_ text: String, to ws: [Word], terms: [VocabTerm]) -> [Word] {
  let key = { (s: String) in s.lowercased().filter { $0.isLetter || $0.isNumber } }
  let forms = Dictionary(terms.map { (key($0.text), [$0.text] + ($0.aliases ?? [])) }, uniquingKeysWith: { a, b in a + b })
  let fits = { (olds: [Word], news: [String]) -> Bool in
    guard let heard = forms[key(news.joined())] else { return false }
    let was = key(olds.map(\.text).joined())
    return heard.contains { similarity(was, key($0)) >= 0.6 }
  }
  let new = text.split(separator: " ").map(String.init)
  let a = ws.map { key($0.text) }, b = new.map(key)
  let diff = b.difference(from: a)
  var removed = Set<Int>(), inserted = Set<Int>()
  for change in diff {
    switch change {
    case .remove(let o, _, _): removed.insert(o)
    case .insert(let o, _, _): inserted.insert(o)
    }
  }
  var out: [Word] = []
  var i = 0, j = 0
  while i < ws.count || j < new.count {
    if i < ws.count && j < new.count && !removed.contains(i) && !inserted.contains(j) {
      out.append(ws[i]); i += 1; j += 1; continue
    }
    var olds: [Word] = [], news: [String] = []
    while i < ws.count && removed.contains(i) { olds.append(ws[i]); i += 1 }
    while j < new.count && inserted.contains(j) { news.append(new[j]); j += 1 }
    if olds.isEmpty && news.isEmpty { break }
    guard let first = olds.first, let last = olds.last, !news.isEmpty else { continue }
    if !fits(olds, news) { warn("word list: kept \(olds.map(\.text).joined()) (not spelled like \(news.joined(separator: " ")))"); out += olds; continue }
    warn("word list: \(olds.map(\.text).joined()) -> \(news.joined(separator: " "))")
    let tail = String(last.text.reversed().prefix { ".,;:?!\"”’)".contains($0) }.reversed())
    let lead = String(first.text.trimmingCharacters(in: .whitespaces).prefix { "\"“‘(".contains($0) })
    let step = Double(last.end - first.start) / Double(news.count)
    for (k, n) in news.enumerated() {
      var t = n
      if k == 0 && !lead.isEmpty && !t.hasPrefix(lead) { t = lead + t }
      if k == news.count - 1 && !tail.isEmpty && !t.hasSuffix(tail) { t = t.trimmingCharacters(in: CharacterSet(charactersIn: ".,;:?!")) + tail }
      out.append(Word(start: first.start + Int((Double(k) * step).rounded()), end: first.start + Int((Double(k + 1) * step).rounded()), text: " " + t))
    }
  }
  return out
}

func runParakeet(_ audio: URL, _ out: URL, withSpeakers: Bool, count: Int?) async throws {
  let samples = try AudioConverter().resampleAudioFile(audio)
  emit("Parakeet", 0.05)
  let asr = AsrManager(config: .default)
  try await asr.loadModels(try await AsrModels.downloadAndLoad(to: parakeetDir, version: .v3))
  var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
  let result = try await asr.transcribe(samples, decoderState: &state, language: .english)
  var ws = words(from: result.tokenTimings ?? [])
  if let terms = vocab?.terms, !terms.isEmpty { emit("Word list", 0.5); ws = await boost(ws, result, samples, terms) }
  var labels: [String?] = ws.map { _ in nil }
  if withSpeakers && !ws.isEmpty {
    emit("Speakers", 0.6)
    // When the person said who is speaking, the number of voices is known.
    var config = OfflineDiarizerConfig.default
    if let n = count, n >= 2 { config.clustering.numSpeakers = n }
    let diarizer = OfflineDiarizerManager(config: config)
    try await diarizer.prepareModels(directory: speakersDir)
    let found = try await diarizer.process(audio: samples) { done, total in emit("Speakers", 0.6 + 0.4 * Double(done) / Double(max(1, total))) }
    if ProcessInfo.processInfo.environment["TD_SPEECH_DEBUG"] != nil {
      for t in found.segments.sorted(by: { $0.startTimeSeconds < $1.startTimeSeconds }).prefix(40) {
        FileHandle.standardError.write(Data("turn \(t.speakerId) \(t.startTimeSeconds)-\(t.endTimeSeconds)\n".utf8))
      }
      for w in ws.prefix(400) { FileHandle.standardError.write(Data("word \(w.start)-\(w.end) \(w.text)\n".utf8)) }
    }
    labels = label(ws, with: found.segments)
  }
  try write(segments(ws, labels), to: out)
}

// ---------------------------------------------------------------- Whisper

// Whisper's segments as the app reads them, moved later by `offset` ms. On music or silence Whisper can say its
// prompt back; a run of three or more words that is only the prompt again is that, not speech.
func whisperSegments(_ results: [TranscriptionResult], offset: Int = 0, echo: String = "") -> [Segment] {
  let key = { (s: String) in s.lowercased().split { !$0.isLetter && !$0.isNumber }.joined(separator: " ") }
  let prompt = key(echo)
  var segs: [Segment] = []
  for r in results {
    for s in r.segments {
      let ws = (s.words ?? []).filter { !$0.word.trimmingCharacters(in: .whitespaces).isEmpty && !$0.word.hasPrefix("<|") }
        .map { Word(start: offset + ms(Double($0.start)), end: offset + ms(Double($0.end)), text: $0.word) }
      guard let first = ws.first, let last = ws.last else { continue }
      let said = key(ws.map(\.text).joined(separator: " "))
      if !prompt.isEmpty && ws.count >= 3 && (" " + prompt + " ").contains(" " + said + " ") { warn("dropped a repeat of the prompt: \(said)"); continue }
      segs.append(Segment(start: first.start, end: last.end, text: ws.map(\.text).joined().trimmingCharacters(in: .whitespaces),
        words: ws, speaker: nil))
    }
  }
  return segs
}

let HOLE = 6000  // ms without a word that Whisper is asked to listen to again

func runWhisper(_ audio: URL, _ out: URL) async throws {
  // The tokenizer is the app's copy too: without tokenizerFolder WhisperKit fetches its own into ~/Documents.
  let kit = try await WhisperKit(WhisperKitConfig(modelFolder: whisperDir.path, tokenizerFolder: tokenizerDir, verbose: false,
    logLevel: .error, prewarm: false, load: true, download: false))
  let samples = try AudioConverter().resampleAudioFile(audio)
  emit("Whisper", 0.05)
  let plain = DecodingOptions(verbose: false, task: .transcribe, language: "en", temperature: 0, usePrefillPrompt: true,
    skipSpecialTokens: true, wordTimestamps: true, chunkingStrategy: .vad)
  var options = plain
  // The word list as the text before each window, so Whisper writes "Keller" where it would write "Kellar".
  let prompt = (vocab?.prompt ?? "").trimmingCharacters(in: .whitespaces)
  if !prompt.isEmpty, let tokenizer = kit.tokenizer {
    options.promptTokens = tokenizer.encode(text: " " + prompt).filter { $0 < tokenizer.specialTokens.specialTokenBegin }
  }
  var segs = whisperSegments(try await kit.transcribe(audioArray: samples, decodeOptions: options), echo: prompt)

  // Whisper now and then skips a stretch of speech, a whole window at a time and more often with a prompt
  // (46 seconds of a 26-minute recording). Each long silence is heard again on its own, without the prompt.
  let total = ms(Double(samples.count) / 16000)
  var holes: [(Int, Int)] = []
  var heard = 0
  for w in segs.flatMap(\.words).sorted(by: { $0.start < $1.start }) {
    if w.start - heard > HOLE { holes.append((heard, w.start)) }
    heard = max(heard, w.end)
  }
  if total - heard > HOLE { holes.append((heard, total)) }
  for (a, b) in holes {
    let lo = max(0, a * 16), hi = min(samples.count, b * 16)
    guard hi - lo > 16000 else { continue }
    let found = whisperSegments(try await kit.transcribe(audioArray: Array(samples[lo..<hi]), decodeOptions: plain), offset: a)
      .filter { $0.start >= a - 250 && $0.end <= b + 250 }
    if !found.isEmpty { warn("heard again \(a / 1000)s to \(b / 1000)s: \(found.reduce(0) { $0 + $1.words.count }) words") }
    segs += found
  }
  try write(segs.sorted { $0.start < $1.start }, to: out)
}

// ---------------------------------------------------------------- main

do {
  switch command {
  case "parakeet", "whisper":
    guard positional.count == 2 else { fail("usage: transcriber-speech \(command) --models <dir> <audio> <out.json>") }
    let needs = command == "parakeet" ? [models.appendingPathComponent("parakeet-tdt-0.6b-v3"), speakersDir] : [whisperDir, tokenizerDir]
    guard needs.allSatisfy({ present($0) }) else { fail("The speech models are not downloaded yet.") }
    let audio = URL(fileURLWithPath: positional[0]), out = URL(fileURLWithPath: positional[1])
    guard FileManager.default.fileExists(atPath: audio.path) else { fail("No recording at \(audio.path)") }
    if command == "parakeet" { try await runParakeet(audio, out, withSpeakers: speakers, count: speakerCount) }
    else { try await runWhisper(audio, out) }
  default:
    fail("Unknown command \(command). Use parakeet or whisper.")
  }
} catch {
  fail("\(error.localizedDescription)")
}
