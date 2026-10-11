"""Delivers transactional emails (order confirmations, password resets) from the email_jobs queue."""

import logging
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage

MAX_ATTEMPTS = 3

log = logging.getLogger("email_worker")


@dataclass
class EmailJob:
    id: str
    to: str
    subject: str
    body: str
    attempts: int = 0


def send_email(job: EmailJob, host: str = "localhost", port: int = 25) -> None:
    message = EmailMessage()
    message["To"] = job.to
    message["From"] = "orders@tidepool.example"
    message["Subject"] = job.subject
    message.set_content(job.body)
    with smtplib.SMTP(host, port, timeout=10) as smtp:
        smtp.send_message(message)


class EmailWorker:
    """Pulls jobs from a queue and sends them, retrying failed sends up to MAX_ATTEMPTS times."""

    def __init__(self, queue):
        self.queue = queue

    def process(self, job: EmailJob) -> None:
        try:
            send_email(job)
        except (smtplib.SMTPException, OSError) as err:
            job.attempts += 1
            if job.attempts < MAX_ATTEMPTS:
                self.queue.put(job)
            log.warning("send failed for %s: %s", job.id, err)

    def run_forever(self) -> None:
        while True:
            self.process(self.queue.get())
