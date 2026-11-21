import pathlib
import subprocess

source = subprocess.check_output(["git", "show", "main:packages/core/src/memory/graph.ts"]).decode()
page = source.split("return `<!doctype html>\n", 1)[1].rsplit("`\n}", 1)[0]
page = "<!doctype html>\n" + page.replace("${data}", "__YCODING_KNOWLEDGE_DATA__")
pathlib.Path(__file__).with_name("page.html").write_bytes(page.encode())
