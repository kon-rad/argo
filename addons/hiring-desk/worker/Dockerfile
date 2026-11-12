FROM python:3.12-alpine
RUN addgroup -S -g 10001 worker && adduser -S -D -H -u 10001 -G worker worker
WORKDIR /worker
COPY worker.py /worker/worker.py
USER 10001:10001
ENTRYPOINT ["python", "-I", "/worker/worker.py"]
