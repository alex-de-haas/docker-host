"""Isolated JSONL worker for the official OPUS-MT Marian archive converted to INT8."""
import json
from pathlib import Path
import sys
import time

started = time.perf_counter()
import ctranslate2
import sentencepiece
imports_ms = (time.perf_counter() - started) * 1000
root = Path(sys.argv[1])
beam_size = int(sys.argv[2]) if len(sys.argv) > 2 else 1
started = time.perf_counter()
source = sentencepiece.SentencePieceProcessor(model_file=str(root / "original/source.spm"))
target = sentencepiece.SentencePieceProcessor(model_file=str(root / "original/target.spm"))
translator = ctranslate2.Translator(str(root / "int8"), device="cpu", compute_type="int8", inter_threads=1, intra_threads=8)
print(json.dumps({"ready": True, "importsMilliseconds": imports_ms,
                  "loadMilliseconds": (time.perf_counter() - started) * 1000,
                  "ctranslate2": ctranslate2.__version__, "sentencepiece": sentencepiece.__version__}), flush=True)
for line in sys.stdin:
    try:
        request = json.loads(line)
        started = time.perf_counter()
        tokens = [source.encode(text, out_type=str) for text in request["texts"]]
        if any(len(part) > 512 for part in tokens):
            raise ValueError("Input exceeds the probe's 512-token safety limit; no truncation performed.")
        tokenized = time.perf_counter()
        results = translator.translate_batch(tokens, beam_size=beam_size, max_batch_size=32,
                                             max_input_length=512, max_decoding_length=512)
        inferred = time.perf_counter()
        if any(len(result.hypotheses[0]) >= 512 for result in results):
            raise ValueError("Output reached the decoding limit.")
        translations = [target.decode(result.hypotheses[0]) for result in results]
        print(json.dumps({"translations": translations, "tokenizeMilliseconds": (tokenized-started)*1000,
                          "inferenceMilliseconds": (inferred-tokenized)*1000,
                          "decodeMilliseconds": (time.perf_counter()-inferred)*1000,
                          "inputTokens": sum(map(len, tokens)),
                          "outputTokens": sum(len(result.hypotheses[0]) for result in results)}), flush=True)
    except Exception as error:
        print(json.dumps({"error": str(error)}), flush=True)
