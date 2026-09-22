import os
import requests
from locust import HttpUser, between, events, task

BASE = os.environ.get("TRACER_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
PROFILE_HEADERS = {}

@events.test_start.add_listener
def bootstrap_profile(environment, **kwargs):
    session = requests.Session()
    login = session.post(
        BASE + "/api/v1/auth/login",
        json={"email": "alex.morgan@example.test", "password": "password123"},
        timeout=10,
    )
    login.raise_for_status()
    session_headers = {"Authorization": "Bearer " + login.json()["data"]["token"]}
    profiles = session.get(BASE + "/api/v1/profiles", headers=session_headers, timeout=10)
    profiles.raise_for_status()
    profile_id = profiles.json()["data"][0]["_id"]
    switched = session.post(
        BASE + "/api/v1/auth/switch-profile",
        headers=session_headers,
        json={"profileId": profile_id},
        timeout=10,
    )
    switched.raise_for_status()
    PROFILE_HEADERS.clear()
    PROFILE_HEADERS.update({"Authorization": "Bearer " + switched.json()["data"]["token"]})

class TracerReadUser(HttpUser):
    wait_time = between(0.05, 0.2)

    @task(4)
    def collections(self):
        self.client.get("/api/v1/collections", headers=PROFILE_HEADERS, name="/api/v1/collections")

    @task(3)
    def environments(self):
        self.client.get("/api/v1/environments", headers=PROFILE_HEADERS, name="/api/v1/environments")

    @task(3)
    def history(self):
        self.client.get("/api/v1/history?limit=20", headers=PROFILE_HEADERS, name="/api/v1/history")

    @task(2)
    def preferences(self):
        self.client.get("/api/v1/preferences", headers=PROFILE_HEADERS, name="/api/v1/preferences")

    @task(1)
    def health(self):
        self.client.get("/api/v1/health", name="/api/v1/health")
