FROM node:20-bookworm

# System dependencies: Ghostscript (CMYK/PDF-X conversion), poppler-utils
# (preflight checks), potrace + librsvg2-bin (vectorizer, sticker cut-out),
# python3 + pip (AI upscaler, background remover).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ghostscript \
    poppler-utils \
    potrace \
    librsvg2-bin \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir \
    rembg \
    onnxruntime \
    opencv-contrib-python-headless \
    numpy \
    pillow

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
