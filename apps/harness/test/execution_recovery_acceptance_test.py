"""The fixture report must bind the authoritative v2 row to the exact independent OS receipt."""
import copy
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

from execution_recovery_acceptance import native_proof, assert_closed, assert_same_attempt


class NativeEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.data = Path(self.temp.name)
        self.target = {'ref': {'id': 'run', 'provider': {'appId': 'provider', 'installationId': 'installation', 'key': 'default'}},
                       'generation': 'generation', 'sessionId': 'session'}
        root = self.data / 'agent-sessions'
        root.mkdir()
        with sqlite3.connect(root / 'execution-v2.sqlite') as db:
            db.executescript('CREATE TABLE execution_runs (id, session, body); CREATE TABLE execution_sessions (id, body); CREATE TABLE native_attempts (id, payload)')
            db.execute('INSERT INTO execution_runs VALUES (?, ?, ?)', ('run','session',json.dumps({'snapshot':self.target})))
            db.execute('INSERT INTO execution_sessions VALUES (?, ?)', ('session',json.dumps({'id':'session','session':{'activeRun':None},'nativeId':'native'})))
            db.execute('INSERT INTO native_attempts VALUES (?, ?)', ('run',json.dumps({'receipt':{'runId':'run','generation':'native-gen','state':'cancelled','effects':{'remote':'unknown'}},
                    'events':[{'event':{'type':'tool_use', 'input':'private tool content'}}]})))
        self.tree = self.data / 'native-processes/run/generation'
        self.tree.mkdir(parents=True)
        self.ids = {'runId':'run', 'generation':'generation'}
        (self.tree / 'manifest.json').write_text(json.dumps({**self.ids, 'producerPid':32, 'producerNonce':'owner','spawns':['one']}))
        self.file = self.tree / 'one.json'
        self.file.write_text(json.dumps({**self.ids,'nonce':'one','state':'stopped','treeStopped':True}))
    def test_physical_exit_and_unknown_effect_are_independent(self):
        proof = native_proof(self.data,self.target)
        assert_closed(proof)
        self.assertEqual(proof['effectIds'],['remote'])
        self.assertNotIn('private tool content',json.dumps(proof))
        assert_same_attempt(proof,copy.deepcopy(proof))
        for key in ('generation','producerNonce','nativeGeneration','spawns'):
            changed = {**proof,key:'different'}
            with self.subTest(key=key), self.assertRaises(AssertionError):
                assert_same_attempt(proof,changed)
    def test_receipts_must_match_the_original_nonce_and_generation(self):
        self.file.write_text(json.dumps({**self.ids,'nonce':'another','state':'stopped','treeStopped':True}))
        with self.assertRaises(AssertionError):
            native_proof(self.data,self.target)
        self.file.write_text(json.dumps({**self.ids,'nonce':'one','state':'unknown','treeStopped':False}))
        with self.assertRaises(AssertionError):
            assert_closed(native_proof(self.data,self.target))


if __name__ == '__main__':
    unittest.main()
