FROM node:22-bookworm-slim
# TeX Live: full-ish set so most documents compile. Use texlive-full for everything (~5 GB).
RUN apt-get update && apt-get install -y --no-install-recommends \
      latexmk texlive-latex-recommended texlive-latex-extra texlive-fonts-recommended texlive-fonts-extra \
      texlive-science texlive-xetex texlive-luatex texlive-bibtex-extra texlive-publishers texlive-pictures \
      biber ghostscript && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN node build.js
ENV HOST=0.0.0.0 PORT=3000 PROJECTS_DIR=/data ACCOUNTS=1 SECURE_COOKIES=1
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
