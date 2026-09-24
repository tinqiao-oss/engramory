"""A scripted stand-in for the DeepSeek API, so a real dsh can be driven with no key.

dsh sends every model request to `$DEEPSEEK_BASE_URL`. Point that here and each
request is recorded, and each reply is the next step of a short script: a tool call
the "model" wants made, or a line of text. What dsh does with those tool calls — and
what it reports back in the next request — is then the real host's behaviour, which
is the part a mock cannot give you.

Two wire formats, because dsh changed format under the plugin: 0.1.7 speaks the
Anthropic Messages API (`POST {base}/v1/messages`), 0.1.5 and earlier speak OpenAI
chat completions (`POST {base}/chat/completions`). Both stream (SSE), and both are
answered from the same script. Anything else gets a 404, so a wire change shows up as
an error instead of a silently wrong reply.

Only requests that carry `tools` are the agent loop and advance the script. dsh also
asks the model for a session title on every run — a request with no tools — and
letting that one consume a step would shift every later reply by one.

Standard library only, like the rest of the repo.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class FakeLLM:
    """Serve `plan` on 127.0.0.1 until the `with` block exits.

    Each step is `{"text": "..."}` or `{"tool": "<name>", "args": {...}}`; once the
    plan runs out every reply is `{"text": "done"}`. Tool calls carry the id
    `step<N>` (N = the step's index), so results can be matched by id rather than by
    position. `main` collects the agent-loop request bodies in order, `paths` every
    POST path (which tells you the wire format), and `observe(i, body)` — if given —
    runs as agent-loop request `i` arrives, before it is answered: by then dsh has
    finished acting on step `i - 1`, which is the moment to look at the disk.
    """

    def __init__(self, plan, observe=None):
        self.plan = list(plan)
        self.observe = observe
        self.main = []
        self.other = []
        self.paths = []
        self._lock = threading.Lock()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(self))
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def base_url(self):
        return "http://127.0.0.1:%d" % self._server.server_address[1]

    def __enter__(self):
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._server.shutdown()
        self._server.server_close()

    def _step_for(self, body):
        """Return (step index or None, step) for one model request."""
        with self._lock:
            if not (isinstance(body, dict) and body.get("tools")):
                self.other.append(body)
                return None, {"text": "Engramory check"}
            self.main.append(body)
            i = len(self.main) - 1
            if self.observe is not None:
                self.observe(i, body)
        return i, (self.plan[i] if i < len(self.plan) else {"text": "done"})


def _handler(fake):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # keep the harness output readable
            pass

        def _json(self, obj, status=200):
            data = json.dumps(obj).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _open_stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True

        def _send(self, payload, event=None):
            if event is not None:
                self.wfile.write(("event: %s\n" % event).encode("utf-8"))
            data = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
            self.wfile.write(("data: %s\n\n" % data).encode("utf-8"))
            self.wfile.flush()

        def do_GET(self):
            path = urlsplit(self.path).path.rstrip("/")
            if path.endswith("/models"):
                return self._json({"data": [{"id": "deepseek-flash", "type": "model"}]})
            return self._json({"error": {"message": "fake_llm: no such endpoint %s" % path}}, 404)

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(n) if n else b""
            try:
                body = json.loads(raw) if raw else {}
            except ValueError:
                body = {}
            path = urlsplit(self.path).path.rstrip("/")
            fake.paths.append(path)
            if path.endswith("/count_tokens"):
                return self._json({"input_tokens": 1})
            if path.endswith("/messages"):
                return self._messages(body, *fake._step_for(body))
            if path.endswith("/chat/completions"):
                return self._chat(body, *fake._step_for(body))
            return self._json({"error": {"message": "fake_llm: no such endpoint %s" % path}}, 404)

        def _messages(self, body, i, step):
            """Anthropic Messages streaming: dsh 0.1.7 and later."""
            self._open_stream()
            ev = lambda obj: self._send(obj, event=obj["type"])  # noqa: E731
            ev({"type": "message_start", "message": {
                "id": "msg_fake", "type": "message", "role": "assistant",
                "model": body.get("model", "deepseek-flash"), "content": [],
                "stop_reason": None, "stop_sequence": None,
                "usage": {"input_tokens": 1, "output_tokens": 1}}})
            if "tool" in step:
                ev({"type": "content_block_start", "index": 0, "content_block": {
                    "type": "tool_use", "id": "step%d" % i, "name": step["tool"], "input": {}}})
                ev({"type": "content_block_delta", "index": 0, "delta": {
                    "type": "input_json_delta",
                    "partial_json": json.dumps(step["args"], ensure_ascii=False)}})
                stop = "tool_use"
            else:
                ev({"type": "content_block_start", "index": 0,
                    "content_block": {"type": "text", "text": ""}})
                ev({"type": "content_block_delta", "index": 0,
                    "delta": {"type": "text_delta", "text": step["text"]}})
                stop = "end_turn"
            ev({"type": "content_block_stop", "index": 0})
            ev({"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                "usage": {"output_tokens": 1}})
            ev({"type": "message_stop"})

        def _chat(self, body, i, step):
            """OpenAI chat-completions streaming: dsh 0.1.5 and earlier."""
            self._open_stream()
            model = body.get("model", "deepseek-chat")

            def chunk(delta, finish=None, usage=False):
                c = {"id": "chatcmpl-fake", "object": "chat.completion.chunk", "created": 1,
                     "model": model,
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                if usage:
                    c["usage"] = {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
                self._send(c)

            chunk({"role": "assistant", "content": ""})
            if "tool" in step:
                chunk({"tool_calls": [{
                    "index": 0, "id": "step%d" % i, "type": "function",
                    "function": {"name": step["tool"],
                                 "arguments": json.dumps(step["args"], ensure_ascii=False)}}]})
                chunk({}, finish="tool_calls", usage=True)
            else:
                chunk({"content": step["text"]})
                chunk({}, finish="stop", usage=True)
            self._send("[DONE]")

    return Handler
