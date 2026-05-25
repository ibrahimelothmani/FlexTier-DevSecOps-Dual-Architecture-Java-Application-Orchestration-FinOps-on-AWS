# ==========================================
# Stage 1: Build Java Application using Maven
# ==========================================
FROM maven:3.6.3-jdk-8-slim AS builder

WORKDIR /app

# Copy the pom.xml and download project dependencies (for caching)
COPY pom.xml .
RUN mvn dependency:go-offline -B

# Copy the source code and build the war archive
COPY src ./src
RUN mvn clean package -DskipTests -B

# ==========================================
# Stage 2: Run Tomcat Servlet Container
# ==========================================
FROM tomcat:9.0-jdk8-openjdk-slim

# Remove default Tomcat web applications
RUN rm -rf /usr/local/tomcat/webapps/*

# Copy the compiled war file from the builder stage as the default ROOT application
COPY --from=builder /app/target/dptweb-1.0.war /usr/local/tomcat/webapps/ROOT.war

# Expose HTTP port 8080 for standard web traffic
EXPOSE 8080

# Run Tomcat Catalina servlet container
CMD ["catalina.sh", "run"]
