# UC-1 AI/ML model service — the eight WS2 UC-I models behind one FastAPI app.
#
# Served to the SPA through nginx at /ml-api (deploy/nginx.conf). It carries no
# auth of its own, so it listens on the compose network only and is never
# published to a host port in production.
FROM python:3.11-slim

WORKDIR /app

# Runtime subset only — see requirements-service.txt for what is left out and
# which documented fallback each omission triggers.
COPY requirements-service.txt ./
RUN pip install --no-cache-dir -r requirements-service.txt

# Source, the trained M3 artefact, and the reference data the models read
# (berth roster + the extracted DSR berth stays that give M4 its real 21-berth
# occupancy instead of a synthetic one). The raw document corpus is NOT copied:
# it is 112 MB of source PDFs that only the extractors read.
COPY src ./src
COPY run.py conftest.py ./
COPY trained_models ./trained_models
COPY data ./data

# The app refuses to start if the four copies of the DUKC core have drifted or
# any golden-value self-test fails — a build-time gate on the safety physics.
# Doing it here means a bad image fails to BUILD rather than failing in front of
# an operator.
RUN JNPA_PORT=0 python -c "import sys; sys.path.insert(0, 'src/pipeline'); \
    import jnpa_paths; jnpa_paths.ensure_on_syspath(); \
    import api; assert api.ADAPTER['mounted'], api.ADAPTER; \
    print('mounted', len(api.MOUNTED), 'models +', api.ADAPTER['module_id'])"

ENV JNPA_HOST=0.0.0.0 \
    JNPA_PORT=8100 \
    PYTHONUNBUFFERED=1

EXPOSE 8100

# Non-root: the service writes nothing outside /tmp.
RUN useradd --create-home --uid 10001 mlsvc && chown -R mlsvc /app
USER mlsvc

CMD ["python", "run.py", "serve"]
