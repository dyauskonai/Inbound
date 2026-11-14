import json

from server.voice import accept


class Decoder:
    def __init__(self,text,confidence=1):
        self.text=text
        self.confidence=confidence
    def AcceptWaveform(self,pcm): return True
    def Result(self):
        return json.dumps({"text":self.text,"result":[{"conf":self.confidence,"end":1.2}]})


def test_commands_are_complete_utterances():
    assert accept(Decoder('start recording'),b'')['command']=='start'
    assert accept(Decoder('snap'),b'')['command']=='snap'
    assert accept(Decoder('stop recording'),b'')['command']=='stop'
    assert accept(Decoder('please stop the bleeding'),b'')['command'] is None
    assert accept(Decoder('snap',0.3),b'')['command'] is None
