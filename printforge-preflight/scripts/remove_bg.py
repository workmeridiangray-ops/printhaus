#!/usr/bin/env python3
"""
Background remover using rembg (U^2-Net-based salient object segmentation).
Usage: python3 remove_bg.py <input> <output.png>
Output is always PNG with an alpha channel (transparent background).
"""
import sys
from rembg import remove, new_session

def main():
    if len(sys.argv) != 3:
        print('Usage: remove_bg.py <input> <output.png>', file=sys.stderr)
        sys.exit(1)
    input_path, output_path = sys.argv[1], sys.argv[2]

    with open(input_path, 'rb') as f:
        input_bytes = f.read()

    session = new_session('u2net')
    output_bytes = remove(input_bytes, session=session)

    with open(output_path, 'wb') as f:
        f.write(output_bytes)

    print('ok')

if __name__ == '__main__':
    main()
