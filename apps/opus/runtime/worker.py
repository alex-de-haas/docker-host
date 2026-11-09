"""Bounded JSONL protocol; document contents are never logged or persisted."""
import json
import os
from pathlib import Path
import sys
from model import prepare, SPEC

MAX_LINE_BYTES = 2_097_152
MAX_TOKENS = 512


def emit(value):
    print(json.dumps(value, ensure_ascii=True), flush=True)


def main():
    import ctranslate2
    import sentencepiece
    if ctranslate2.__version__ != '4.8.3' or sentencepiece.__version__ != '0.2.2':
        raise ValueError('Pinned runtime dependencies are required')
    threads = int(sys.argv[2])
    if not 1 <= threads <= 32:
        raise ValueError('Invalid thread count')
    folder = prepare(Path(sys.argv[1]))
    source = sentencepiece.SentencePieceProcessor(model_file=str(folder / 'source.spm'))
    target = sentencepiece.SentencePieceProcessor(model_file=str(folder / 'target.spm'))
    engine = ctranslate2.Translator(str(folder / 'model'), device='cpu', compute_type='int8', inter_threads=1,
                                   intra_threads=min(threads, os.cpu_count() or 1))
    emit({'ready': True, 'backend': 'ctranslate2/opus-mt-tc-big-en-zle/int8/cpu', 'model': SPEC['id']})
    while line := sys.stdin.buffer.readline(MAX_LINE_BYTES + 1):
        if len(line) > MAX_LINE_BYTES or not line.endswith(b'\n'):
            raise ValueError('Protocol input too large')
        try:
            request = json.loads(line)
            texts = request['texts']
            if not isinstance(texts, list) or len(texts) > 32 or any(not isinstance(t, str) for t in texts):
                raise ValueError('Invalid fragment batch')
            tokens = [[SPEC['prefix']] + source.encode(t, out_type=str) for t in texts]
            if any(len(t) > MAX_TOKENS for t in tokens):
                emit({'error': 'translation_segment_too_large'})
                continue
            results = engine.translate_batch(tokens, beam_size=1, max_batch_size=32, max_input_length=MAX_TOKENS,
                                             max_decoding_length=MAX_TOKENS)
            if any(len(r.hypotheses[0]) >= MAX_TOKENS for r in results):
                emit({'error': 'translation_result_too_large'})
                continue
            translations = [target.decode(r.hypotheses[0]) for r in results]
            emit({'translations': translations})
        except Exception:
            emit({'error': 'translation_failed'})


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('OPUS worker stopped: ' + type(error).__name__, file=sys.stderr, flush=True)
        sys.exit(1)
