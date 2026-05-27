# ☕ FlexTier-DevSecOps: Dual-Architecture Java Application Orchestration & FinOps on AWS

Welcome to **FlexTier-DevSecOps** — a high-efficiency deployment and orchestration repository for Java Spring Boot applications. This project showcases how to transition a legacy Java servlet (packaged as a WAR) into modern containerized infrastructures using two distinct pathways: a cost-optimized, single-node K3s cluster managed via Ansible, and an enterprise-grade, Multi-AZ ECS Fargate layout.

---

## 🏛️ System Architecture Options

To support different operational budgets, scaling requirements, and environment tiers (e.g., Development vs. Production), this repository supports **two distinct architectural models**:

---

### Cost-Optimized K3s DevSecOps Architecture (FinOps Tailored)
*Recommended for Dev/Test, Staging, or high-efficiency workloads ($36.30/mo).*

Our primary cost-optimized deployment architecture collapses container orchestration onto a single robust EC2 host running **K3s (lightweight Kubernetes)**. By placing the K3s host in a public subnet with native Layer 4 load balancing and routing, we completely eliminate costly Application Load Balancers (ALBs) and NAT Gateways. The database is securely isolated inside a private subnet.

![Cost-Optimized K3s Architecture](./k3s_optimized_architecture.png)

#### 🌟 Key Architecture Pillars:
1. **Lightweight Orchestration:** Declarative pod deployment (3 replicas for high availability at the application tier) using a minimal K3s footprint, saving host resource overhead.
2. **Infrastructure-as-Code & CM:** Automatic server provisioning and secure dependency configuration managed continuously using **Ansible**.
3. **Secret Injection Protection:** Real-time secret and API-key retrieval at runtime using **HashiCorp Vault**, avoiding plain-text secrets in git.
4. **Comprehensive Telemetry:** Native JVM and container-level monitoring via Prometheus scraping, with visually rich tracking dashboards in Grafana.
5. **FinOps Cost Optimization:** Achieves a massive **84.7% cost reduction** ($36.30/mo vs. $237.76/mo) compared to standard enterprise models by shedding redundant NAT and ALB costs.

## ☕ Java Application Profile & Security Audit

The core application inside `/Java-App` is a standard Spring Boot MVC web application packaged as a Web Application Archive (`WAR`) file, designed to execute inside an **Apache Tomcat** servlet container.

### Core Stack
* **Runtime:** JRE / JDK 1.8 (Java 8)
* **Framework:** Spring Boot Starter Web (v2.2.4.RELEASE)
* **View Technology:** JavaServer Pages (JSP) compiling via `tomcat-jasper`
* **Database Driver:** MySQL Connector Java
* **Build System:** Maven (`pom.xml`)

### 🚨 Crucial Security Vulnerabilities Resolved:
During early security analysis, two high-risk security flaws were identified and fixed:
* **Hardcoded Credentials:** Resolved by eliminating plain-text passwords in `application.properties` and refactoring the app to inject parameters (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USERNAME`, `DB_PASSWORD`) via dynamic container environment variables.
* **SQL Injection Vulnerability:** Standardized database controllers ([login.java](file:///home/the-green/Desktop/Devops%20Project/End-To-End-Deploy-Java-Application-on-AWS-3-Tier-Architecture/Java-App/src/main/java/com/dpt/demo/login.java) and [register.java](file:///home/the-green/Desktop/Devops%20Project/End-To-End-Deploy-Java-Application-on-AWS-3-Tier-Architecture/Java-App/src/main/java/com/dpt/demo/register.java)) to utilize parameterized **PreparedStatements** instead of raw query string concatenation.

---

## 🛠️ The DevSecOps Extension Roadmap

For lightweight applications, a complex AWS 3-tier Fargate setup may introduce unnecessary cloud costs and maintenance overhead. This section documents our transition path to a modular, production-ready **DevSecOps Platform** incorporating modern industry tools.

### 1. Configuration Management with Ansible
Ansible is introduced to replace manual machine setup with reusable Infrastructure-as-Code (IaC). It standardizes base VMs (e.g. EC2 instance clusters or local servers) by provisioning dependencies, updating patches, and configuring runtime tools.

#### Sample Playbook (`ansible/playbook.yml`):
```yaml
---
- name: Standardize Tomcat Runner Nodes
  hosts: app_servers
  become: yes
  vars:
    tomcat_version: 9.0.86
  tasks:
    - name: Update apt cache and install Java 8 JRE
      apt:
        name: openjdk-8-jre-headless
        state: present
        update_cache: yes

    - name: Create dedicated Tomcat group
      group:
        name: tomcat
        state: present

    - name: Create dedicated Tomcat user
      user:
        name: tomcat
        group: tomcat
        shell: /bin/false
        home: /opt/tomcat

    - name: Download Apache Tomcat
      get_url:
        url: "https://archive.apache.org/dist/tomcat/tomcat-9/v{{ tomcat_version }}/bin/apache-tomcat-{{ tomcat_version }}.tar.gz"
        dest: /tmp/tomcat.tar.gz

    - name: Extract Tomcat to /opt/tomcat
      unarchive:
        src: /tmp/tomcat.tar.gz
        dest: /opt/tomcat
        remote_src: yes
        extra_opts: [--strip-components=1]
        owner: tomcat
        group: tomcat
```

---

### 2. Container Orchestration with Kubernetes (K8s)
To increase resiliency, scaling velocity, and declarative state enforcement, we pivot application orchestration to a Kubernetes cluster (such as local minikube/K3s or AWS EKS).

#### Deployment & Service Manifest (`k8s/app-deployment.yaml`):
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: java-app-deployment
  labels:
    app: java-app
spec:
  replicas: 3
  selector:
    matchLabels:
      app: java-app
  template:
    metadata:
      labels:
        app: java-app
    spec:
      containers:
        - name: java-app-container
          image: java-app:latest
          ports:
            - containerPort: 8080
          env:
            - name: DB_HOST
              value: "mysql-service"
            - name: DB_PORT
              value: "3306"
            - name: DB_NAME
              value: "UserDB"
            - name: DB_USERNAME
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: username
            - name: DB_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: db-credentials
                  key: password
          resources:
            limits:
              cpu: "500m"
              memory: "512Mi"
            requests:
              cpu: "250m"
              memory: "256Mi"
---
apiVersion: v1
kind: Service
metadata:
  name: java-app-service
spec:
  selector:
    app: java-app
  ports:
    - protocol: TCP
      port: 80
      targetPort: 8080
  type: ClusterIP
```

---

### 3. Secret Shielding with HashiCorp Vault
Rather than storing database configurations and encryption keys in static environment variables or git, we integrate **HashiCorp Vault** for centralized secret management, dynamic credential generation, and secure runtime injection.

#### Pod Sidecar Secret Injection Pattern:
We utilize the **Vault Agent Injector** to mount secrets directly into our Kubernetes application pods dynamically as a ramdisk file:
```yaml
spec:
  template:
    metadata:
      annotations:
        vault.hashicorp.com/agent-inject: "true"
        vault.hashicorp.com/role: "java-app-role"
        vault.hashicorp.com/agent-inject-secret-database: "secret/data/mysql"
        vault.hashicorp.com/agent-inject-template-database: |
          {{- with secret "secret/data/mysql" -}}
          export DB_USERNAME="{{ .Data.data.username }}"
          export DB_PASSWORD="{{ .Data.data.password }}"
          {{- end -}}
```

---

### 4. Telemetry & Monitoring with Prometheus & Grafana
For comprehensive observability, we configure a Prometheus-Grafana stack to capture JVM system vitals, HTTP latencies, error frequencies, and network metrics.

#### Prometheus Target Configuration (`prometheus.yml`):
```yaml
global:
  scrape_interval: 15s

scrape_configs:
  - job_name: 'kubernetes-pods'
    kubernetes_sd_configs:
      - role: pod
    relabel_configs:
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_scrape]
        action: keep
        regex: true
      - source_labels: [__meta_kubernetes_pod_annotation_prometheus_io_path]
        action: replace
        target_label: __metrics_path__
        regex: (.+)
      - source_labels: [__address__, __meta_kubernetes_pod_annotation_prometheus_io_port]
        action: replace
        target_label: __address__
        regex: ([^:]+)(?::\d+)?;(\d+)
        replacement: $1:$2
```

#### Grafana Dashboard Metrics Tracker:
1. **JVM Garbage Collection Time:** Tracks memory leaks and memory clean frequency.
2. **Tomcat Active Sessions:** Measures user sessions and thread allocation limits.
3. **HTTP Request Rate & Response Times:** Tracks transaction latency and standard error codes (e.g. 5xx).

---

### 5. Traffic Analysis & Verification with Wireshark & TShark
To perform network security validation, troubleshoot connection drops, and ensure internal database requests are securely isolated, we utilize **Wireshark** (or its CLI variant `tshark`).

#### Common Network Inspection Commands:
* **Capture live MySQL traffic to analyze latency:**
  ```bash
  sudo tshark -i eth0 -Y "mysql" -T fields -e mysql.query
  ```
* **Verify TLS connection Handshake across endpoints:**
  ```bash
  sudo tshark -i eth0 -Y "tls.handshake.type == 1"
  ```
* **Locate unencrypted application headers or payload exchanges:**
  ```bash
  sudo tcpdump -i eth0 -s 0 -A 'tcp port 8080 and (((ip[2:2] - ((ip[0]&0xf)<<2)) - ((tcp[12]&0xf0)>>2)) != 0)'
  ```

---

## 🔒 Security Best Practices & License
This project follows strict security isolation policies. All code modifications undergo Trivy static analysis on every push, and the repository is licensed under the [MIT License](file:///home/the-green/Desktop/Devops%20Project/End-To-End-Deploy-Java-Application-on-AWS-3-Tier-Architecture/LICENSE).
