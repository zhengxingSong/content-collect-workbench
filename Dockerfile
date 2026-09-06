# 多来源数据收集平台 — 后端 + MCP 镜像
# 构建：docker compose build
#
# 基础镜像说明：Docker Hub 直连不可用时（国内网络），默认使用本地已有的
# docker-api:latest（官方 python:3.12.13 镜像派生，Debian trixie）。
# 网络恢复后可用 --build-arg BASE_IMAGE=python:3.12-slim 切回官方基础镜像。
ARG BASE_IMAGE=docker-api:latest
FROM ${BASE_IMAGE}

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONPATH= \
    PIP_INDEX_URL=https://pypi.mirrors.ustc.edu.cn/simple \
    PLAYWRIGHT_DOWNLOAD_HOST=https://npmmirror.com/mirrors/playwright/ \
    WMT_HEADLESS=1

WORKDIR /app

# Debian 源切换 USTC（容器内实测可用），chromium 系统依赖安装用
USER root
RUN (sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || \
     sed -i 's|deb.debian.org|mirrors.ustc.edu.cn|g' /etc/apt/sources.list || true) \
    && apt-get update

# 依赖层（利用构建缓存）；apt 偶发 EOF 用重试兜底
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
RUN for i in 1 2 3 4 5; do \
        python -m playwright install --with-deps chromium && break || \
        { echo "playwright install retry $i"; sleep 8; }; \
    done

# 应用代码
COPY app.py mcp_server.py /app/
COPY backend /app/backend
COPY frontend /app/frontend

# 数据目录（compose 卷挂载覆盖）
RUN mkdir -p /app/data /app/state /app/output

EXPOSE 5200 3333

# 覆写基础镜像残留的 CMD；MCP 服务由 compose 以同镜像不同 command 启动
ENTRYPOINT []
CMD ["python", "app.py", "--no-browser", "--host", "0.0.0.0", "--port", "5200"]
