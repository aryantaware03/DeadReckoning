FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# torch stays optional (DEMO INFERENCE without it); install CPU torch separately if needed.
COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY simulation/ ./simulation/
COPY eskf/ ./eskf/
COPY models/ ./models/
COPY utils/ ./utils/
COPY training/ ./training/
COPY datasets/ ./datasets/
COPY backend/ ./backend/

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health')"

CMD ["uvicorn", "backend.app:app", "--host", "0.0.0.0", "--port", "8000"]
