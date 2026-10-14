FROM hosty-agent-container-experiment:20261013
USER root
COPY entrypoint.sh /opt/experiment-entrypoint.sh
RUN chmod 755 /opt/experiment-entrypoint.sh && command -v setpriv
ENTRYPOINT ["/opt/experiment-entrypoint.sh"]
