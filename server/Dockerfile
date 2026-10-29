# beayy-server：同步、账号、转写任务接口、官方服务代理。不跑模型，几十 MB 内存
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HOME=/home/beayy \
    BEAYY_SYNC_DIR=/data/sync BEAYY_JOBS_DIR=/data/jobs BEAYY_BACKUP_DIR=/backup
RUN useradd --system --uid 1000 --create-home beayy
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY entrypoint.sh server.py syncapi.py usage.py admin.py schema.sql privacy.html ./
EXPOSE 8770
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8770/v2/health', timeout=4)"
ENTRYPOINT ["./entrypoint.sh"]
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8770", "--no-access-log", "--proxy-headers", "--forwarded-allow-ips", "*"]
