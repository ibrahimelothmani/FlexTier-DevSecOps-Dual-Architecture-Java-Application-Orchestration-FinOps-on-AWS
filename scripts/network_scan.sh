#!/usr/bin/env bash

# ==============================================================================
# DEVSECOPS WIRESHARK / TSHARK NETWORK SECURITY AUDIT SCRIPT
# ==============================================================================
# This script monitors network interfaces to analyze application protocol
# flows, detect unencrypted passwords, trace queries, and audit TLS handshakes.
# ==============================================================================

set -euo pipefail

# Banner
echo "======================================================================"
echo "🕵️‍♂️ DevSecOps Network Security Audit & Sniffing Terminal Tool"
echo "======================================================================"

# 1. Dependency checks
if ! command -v tshark &>/dev/null; then
    echo "❌ Error: 'tshark' is not installed. Please install it first:"
    echo "   Ubuntu/Debian: sudo apt-get update && sudo apt-get install -y tshark"
    exit 1
fi

# Detect default interface
INTERFACE=$(ip route | grep default | awk '{print $5}' | head -n1)
if [ -z "${INTERFACE}" ]; then
    INTERFACE="any"
fi

echo "🟢 Sniffer bound to network interface: [${INTERFACE}]"
echo "Please select an auditing mode:"
echo "----------------------------------------------------------------------"
echo "1) 🐬 Audit MySQL queries (Detect plain-text query operations)"
echo "2) 🌐 Monitor Java Application HTTP Traffic (Port 8080)"
echo "3) 🔒 Audit SSL/TLS handshakes (Verify encrypted connections)"
echo "4) 🚨 Leak Detector: Scan for plain-text password transits"
echo "5) 📦 Capture packet stream directly to 'network_audit.pcap'"
echo "----------------------------------------------------------------------"
read -rp "Enter choice [1-5]: " CHOICE

case "${CHOICE}" in
    1)
        echo "🔍 Scanning live MySQL query operations..."
        sudo tshark -i "${INTERFACE}" -Y "mysql.query" -T fields -e frame.time -e ip.src -e ip.dst -e mysql.query
        ;;
    2)
        echo "🔍 Monitoring live Tomcat Web App requests (Port 8080)..."
        sudo tshark -i "${INTERFACE}" -Y "tcp.port == 8080 and http" -T fields \
            -e frame.time -e ip.src -e http.request.method -e http.request.uri -e http.response.code
        ;;
    3)
        echo "🔍 Monitoring TLS Handshakes (Verifying encryption layers)..."
        sudo tshark -i "${INTERFACE}" -Y "tls.handshake.type == 1 or tls.handshake.type == 2" -T fields \
            -e frame.time -e ip.src -e ip.dst -e tls.handshake.version
        ;;
    4)
        echo "🔍 SCANNING FOR PLAIN-TEXT CREDENTIAL LEAKS (HTTP POST payload scan)..."
        sudo tshark -i "${INTERFACE}" -Y "http.request.method == \"POST\"" -T fields \
            -e frame.time -e ip.src -e ip.dst -e http.file_data \
            | grep -E -i "pass|pwd|user|secret" || echo "🟢 No plain-text password exposures detected in captured frame buffers."
        ;;
    5)
        echo "💾 Capturing continuous traffic to 'network_audit.pcap'..."
        echo "Press Ctrl+C to terminate the packet capture session."
        sudo tshark -i "${INTERFACE}" -w network_audit.pcap
        ;;
    *)
        echo "❌ Invalid selection. Exiting."
        exit 1
        ;;
esac
