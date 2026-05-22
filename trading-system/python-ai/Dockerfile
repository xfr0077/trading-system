FROM docker.m.daocloud.io/python:3.12-slim

ENV PYTHONPATH=/app:/app/src
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ src/
COPY models/ models/

RUN echo "*.pyc" > /.dockerignore && echo "__pycache__" >> /.dockerignore && echo "*.pyc" >> /.dockerignore

CMD ["python", "-m", "src.main"]
