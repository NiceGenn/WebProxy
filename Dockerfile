FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY collector ./collector
RUN mkdir -p /data && chown -R 10001:10001 /data /app
USER 10001:10001
VOLUME /data
CMD ["python", "-m", "collector", "run"]
