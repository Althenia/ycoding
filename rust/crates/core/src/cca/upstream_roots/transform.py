from pathlib import Path
import ast
import base64
import hashlib
import re
import sys

header = Path(sys.argv[1]).read_bytes()
if hashlib.sha256(header).hexdigest() != 'd4ed10ddcd8cb9e65a3a2c70154f9e55640cd2ec56bbe6053bb9192e32e69e8e':
    raise SystemExit('unexpected Node 26.4.0 root header')
certificates = [
    ''.join(ast.literal_eval(literal) for literal in re.findall(r'"[^"\n]*"', block))
    for block in re.findall(
        r'(?m)^"-----BEGIN CERTIFICATE-----.*?^"-----END CERTIFICATE-----"',
        header.decode('utf-8'), re.S,
    )
]
if len(certificates) != 120:
    raise SystemExit('unexpected root count')
digests = [
    hashlib.sha256(base64.b64decode(''.join(pem.splitlines()[1:-1]), validate=True)).hexdigest()
    for pem in certificates
]
if len(set(digests)) != 120:
    raise SystemExit('duplicate bundled DER')
if sys.argv[2] == 'rust':
    sys.stdout.write('pub(super) const NODE_26_4_ROOTS: [&str; 120] = [\n')
    for pem in certificates:
        sys.stdout.write('    r"' + pem + '",\n')
    sys.stdout.write('];\n')
elif sys.argv[2] == 'digests':
    sys.stdout.write('pub(super) const EXPECTED_NODE_26_4_DIGESTS: [&str; 120] = [\n')
    for digest in digests:
        sys.stdout.write('    "' + digest + '",\n')
    sys.stdout.write('];\n')
else:
    raise SystemExit('select rust or digests')
