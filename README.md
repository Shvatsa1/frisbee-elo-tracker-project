# Ultimate Frisbee Elo Tracker

This is a modern web application for tracking Ultimate Frisbee games and player Elo ratings.

## Prerequisites
To run this locally, you must install:
1. **Node.js** (version 18 or higher) - Download from [nodejs.org](https://nodejs.org/). (Your current local version is very old).
2. **Docker Desktop** (to easily run PostgreSQL). Alternatively, you can use a local PostgreSQL installation on port 5432.

## Setup Instructions

### 1. Database Setup
If using Docker, run the following from the root directory (`frisbee-elo-tracker`):
```bash
docker-compose up -d
```
This starts a PostgreSQL instance on port 5432 with default credentials.

### 2. Backend Setup
Open a terminal in the `backend` directory:
```bash
cd backend
npm install
npm run init-db
npm run dev
```
The backend will run on `http://localhost:5000`.

### 3. Frontend Setup
Open another terminal in the `frontend` directory:
```bash
cd frontend
npm install
npm run dev
```
The frontend will typically run on `http://localhost:5173`. Open this URL in your browser.

## Features
- **Team-based Elo System:** Elo is calculated based on the average team rating.
- **Dynamic K-Factor:** Players with <15 rated games have K=40, while experienced players have K=20.
- **Historical Tracking:** Every match result and rating change is permanently logged.
- **Modern UI:** Built with React, Tailwind CSS, Recharts for progression graphs, and Lucide icons.
