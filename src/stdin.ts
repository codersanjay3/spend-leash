const STDIN_WAIT_MS = 1000;

/** Resolves on end/error, or after STDIN_WAIT_MS with whatever arrived so far. */
export function readStdin(): Promise<string> {
  return new Promise((res) => {
    let data = "";
    const done = () => {
      clearTimeout(t);
      res(data);
    };
    const t = setTimeout(done, STDIN_WAIT_MS);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      data += c;
    });
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}
