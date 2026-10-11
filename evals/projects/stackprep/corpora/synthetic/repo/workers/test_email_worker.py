import queue
from unittest import mock

from .email_worker import EmailJob, EmailWorker


def test_failed_send_is_requeued():
    q = queue.Queue()
    worker = EmailWorker(q)
    job = EmailJob(id="1", to="a@example.com", subject="Hi", body="Hello")
    with mock.patch("workers.email_worker.send_email", side_effect=OSError("down")):
        worker.process(job)
    assert q.get_nowait() is job
    assert job.attempts == 1
