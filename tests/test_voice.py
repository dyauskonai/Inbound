import json

from server.voice import accept


class Decoder:
    def __init__(self, text, confidence=1):
        self.words = [{"word": word, "conf": confidence, "end": index + 1.0} for index, word in enumerate(text.split())]
        self.text = text

    def AcceptWaveform(self, pcm):
        return True

    def Result(self):
        return json.dumps({"text": self.text, "result": self.words})


def commands(text, confidence=1):
    return [item["command"] for item in accept(Decoder(text, confidence), b"")["commands"]]


def test_commands_are_found_anywhere_in_a_sentence():
    assert commands("start recording") == ["start"]
    assert commands("okay start the handoff now") == ["start"]
    assert commands("take a snap of the left forearm") == ["snap"]
    assert commands("that is all please stop") == ["stop"]
    assert commands("snap that then snap the wound and stop") == ["snap", "snap", "stop"]


def test_negated_and_uncertain_commands_are_ignored():
    assert commands("don't stop compressions") == []
    assert commands("snap", 0.3) == []
    assert commands("pressure is stable") == []


def test_snap_reports_the_time_the_word_was_said():
    result = accept(Decoder("bp is 120 over 80 snap"), b"")
    assert result["commands"] == [{"command": "snap", "end": 6.0}]
