FROM python:3.12-alpine
RUN addgroup -S -g 10002 gateway && adduser -S -D -H -u 10002 -G gateway gateway
RUN mkdir -p /var/lib/desk-gateway && chown gateway:gateway /var/lib/desk-gateway
WORKDIR /gateway
COPY gateway.py /gateway/gateway.py
USER 10002:10002
EXPOSE 8787
ENTRYPOINT ["python", "-I", "/gateway/gateway.py"]
