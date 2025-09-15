import { pool } from "./db/pool.js";

async function setupDatabase() {
  console.log("Setting up database schema...");

  try {
    // Create pages table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pages (
        id SERIAL PRIMARY KEY,
        project VARCHAR(255) NOT NULL,
        url VARCHAR(512) NOT NULL,
        data JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(project, url)
      );
    `);

    // Create indexes
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pages_project ON pages(project)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_pages_updated_at ON pages(updated_at)`);

    // Note: Graphile Worker schema should be installed separately
    console.log("Note: Run 'npx graphile-worker --once --jobs 0' to install worker schema if needed");

    console.log("✓ Database setup complete!");

    // Test database connection
    const result = await pool.query('SELECT NOW() as current_time');
    console.log(`✓ Database connected at: ${result.rows[0].current_time}`);

  } catch (error) {
    console.error("Database setup error:", error);
    throw error;
  }
}

setupDatabase().catch(console.error).finally(() => process.exit(0));