FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    WHISPER_MODEL=small \
    WHISPER_DEVICE=cpu \
    WHISPER_COMPUTE_TYPE=int8 \
    HF_HOME=/models/huggingface

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir fastapi uvicorn[standard] faster-whisper python-multipart

WORKDIR /app
COPY app.py /app/app.py

EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
