#!/bin/sh
# Langsung eksekusi perintah sebagai ROOT. 
# Tidak perlu pusing chown atau su-exec lagi karena root bisa nulis ke mana saja.
exec "$@"