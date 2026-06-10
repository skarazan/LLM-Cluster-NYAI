# NYIT Undergraduate Research and Entrepreneurship (URE) Program
## Mini Grant Proposal — College of Engineering and Computing Sciences

---

**Project Title:** LLM Cluster — Free, Private AI for NYIT Students via Distributed Inference

**Student A:** Saba Karazanashvili — skarazan@nyit.edu — Computer Science

**Student B:** Ameer Teyah — ateyah@nyit.edu — Computer Science

**Student C:** Mate Milorava — mmilorav@nyit.edu — Computer Science

**Faculty Advisor:** Professor Austin Stietzel — Computer Science

**Project Period:** September 2026 — Spring 2027

---

## Objective

Commercial AI tools cost $20+/month per user, putting reliable AI access out of reach for many students. Free tiers are rate-limited and route private coursework through third parties.

**LLM Cluster** is a distributed inference platform that runs open-source large language models (Llama 3, Mistral) across a small fleet of dedicated worker machines hosted by the project. Students access the service through a lightweight client app — they never install or host worker software themselves. The system gives the NYIT community a free, private AI tool whose data never leaves project-controlled hardware.

The grant funds the research needed to turn an early proof-of-concept into a production-ready, evaluated system: scheduling under load, model selection, security, and a formal usability study.

---

## Timeline and Deliverables

### First Semester (14 weeks)

**Weeks 1–3 — Literature review and benchmarking**
Survey distributed inference systems and benchmark commercial baselines on a fixed prompt suite for latency and answer quality.
*Deliverable: literature review + baseline dataset.*

**Weeks 4–8 — Core development**
Design and implement load-balanced request routing, streaming responses, worker authentication, and an admin dashboard. Add support for multiple model families.
*Deliverable: working v1 system.*

**Weeks 9–14 — Testing and recalibration**
Internal load testing (50 / 100 / 200 simulated concurrent users). Tune the scheduler. Begin desktop client refinement.
*Deliverable: performance report + scheduler recommendation.*

### Second Semester (14 weeks)

**Weeks 1–6 — Human subject study (IRB-approved)**
Recruit ~30 NYIT students. Within-subject comparison of LLM Cluster against a commercial baseline on real coursework tasks. Collect latency, answer-quality ratings, and trust measures. Begin mobile (iOS/Android) client development in parallel.
*Deliverable: study dataset + mobile client beta.*

**Weeks 7–14 — Analysis, write-up, dissemination**
Statistical analysis. Draft conference paper for an undergraduate research venue. Public release of the system and mobile app. Final presentation to CoECS faculty.
*Deliverable: paper + public release + final report.*

---

## Signatures

Student A (Saba Karazanashvili): _______________________  Date: __________

Student B (Ameer Teyah): _______________________  Date: __________

Student C (Mate Milorava): _______________________  Date: __________

Faculty Advisor (Prof. Austin Stietzel): _______________________  Date: __________
