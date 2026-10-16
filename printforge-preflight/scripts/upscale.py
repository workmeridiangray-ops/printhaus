#!/usr/bin/env python3
"""
Real learned super-resolution upscaler (not a simple resize/stretch).

Uses OpenCV's dnn_superres module with a pretrained ESPCN (Efficient
Sub-Pixel Convolutional Network) model — a small, fast CNN trained
specifically to reconstruct plausible high-frequency detail when enlarging
an image, which is what actually fixes the "soft/blocky" look a plain
Lanczos/bicubic stretch can't avoid at large scale factors.

Usage: python3 upscale.py <input> <output> <scale: 2|4>
"""
import sys
import os
import cv2

MODELS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'models')


def main():
    if len(sys.argv) != 4:
        print('Usage: upscale.py <input> <output> <scale:2|4>', file=sys.stderr)
        sys.exit(1)

    input_path, output_path, scale_arg = sys.argv[1], sys.argv[2], sys.argv[3]
    scale = int(scale_arg)
    if scale not in (2, 4):
        print('Only 2x and 4x are supported.', file=sys.stderr)
        sys.exit(1)

    img = cv2.imread(input_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        print(f'Could not read image: {input_path}', file=sys.stderr)
        sys.exit(1)

    has_alpha = img.ndim == 3 and img.shape[2] == 4

    sr = cv2.dnn_superres.DnnSuperResImpl_create()
    model_path = os.path.join(MODELS_DIR, f'ESPCN_x{scale}.pb')
    sr.readModel(model_path)
    sr.setModel('espcn', scale)

    if has_alpha:
        bgr = img[:, :, :3]
        alpha = img[:, :, 3]
        up_bgr = sr.upsample(bgr)
        # Alpha channel: a plain resize is fine here (alpha is a soft mask,
        # not image detail the SR model was trained on).
        up_alpha = cv2.resize(alpha, (up_bgr.shape[1], up_bgr.shape[0]), interpolation=cv2.INTER_CUBIC)
        up = cv2.merge([up_bgr[:, :, 0], up_bgr[:, :, 1], up_bgr[:, :, 2], up_alpha])
    else:
        up = sr.upsample(img)

    cv2.imwrite(output_path, up)
    h, w = up.shape[:2]
    print(f'{w}x{h}')


if __name__ == '__main__':
    main()
