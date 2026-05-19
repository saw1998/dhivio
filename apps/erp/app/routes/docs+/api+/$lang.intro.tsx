import { getBrowserEnv } from "@carbon/auth";
import { Alert, AlertDescription, AlertTitle } from "@carbon/react";
import { LuTriangleAlert } from "react-icons/lu";
import { Link } from "react-router";
import {
  CodeSnippet,
  Snippets,
  useApiDocsConfig,
  useSelectedLang
} from "~/modules/api";
import { path } from "~/utils/path";

const { CARBON_API_URL, ERP_URL } = getBrowserEnv();

export default function Route() {
  const selectedLang = useSelectedLang();
  const config = useApiDocsConfig();

  const apiUrl = config.apiUrl || CARBON_API_URL!;
  const apiKey = config.apiKey || "<your-api-key>";

  return (
    <>
      <h2 className="doc-heading">Authentication</h2>
      <div className="doc-section">
        <article className="code-column text-foreground">
          <p>Carbon uses API token authentication for the public API.</p>
          <p>
            First you'll need an <Link to={path.to.apiKeys}>API Key</Link>.
          </p>
          <Alert variant="destructive">
            <LuTriangleAlert className="h-4 w-4 my-1" />
            <AlertTitle className="!my-0 font-bold text-base">
              You should never expose the API key in the client
            </AlertTitle>
            <AlertDescription>
              Your API key gives full access to your database. Never expose it
              in a public-facing client.
            </AlertDescription>
          </Alert>
        </article>
      </div>
      <h2 className="doc-heading">MCP</h2>
      <div className="doc-section">
        <article className="code-column text-foreground">
          <p>
            Dhivio provides an MCP server that you can connect to from any MCP
            client, such as Claude Code or Claude Desktop.
          </p>
          <p>To connect, run the following command with your API token:</p>
          <article>
            <CodeSnippet
              selectedLang={selectedLang}
              snippet={{
                bash: {
                  language: "bash",
                  code: `claude mcp add --transport http \\
  carbon ${ERP_URL}/api/mcp \\
  --header "Authorization: Bearer ${apiKey}"`
                },
                js: {
                  language: "bash",
                  code: `claude mcp add --transport http \\
  carbon ${ERP_URL}/api/mcp \\
  --header "Authorization: Bearer ${apiKey}"`
                }
              }}
            />
          </article>
        </article>
      </div>
      {selectedLang == "js" ? (
        <>
          <h2 className="doc-heading">Client Library SDK</h2>
          <div className="doc-section">
            <article className="code-column text-foreground">
              <p>
                The easiest way to interact with the public API is via the
                JavaScript Client Library SDK.
              </p>
              <p>Save the API Key as an Environment Variable.</p>
              <article>
                <CodeSnippet
                  selectedLang={selectedLang}
                  snippet={Snippets.env({ apiUrl, apiKey })}
                />
              </article>
              <p>
                The API Key is provided via the <code>Authorization</code>{" "}
                header when making requests to the API.
              </p>
              <p>
                As with your API Key, we recommend setting your Client Key as an
                Environment Variable.
              </p>
              <p>Initialize the client as follows:</p>
              <div className="doc-section doc-section--client-libraries">
                <article className="code">
                  <CodeSnippet
                    selectedLang={selectedLang}
                    snippet={Snippets.init(apiUrl)}
                  />
                </article>
              </div>
              <p>
                You can now make requests to the API using the client. See the
                specific tables and views for more details.
              </p>
            </article>
          </div>
        </>
      ) : null}
    </>
  );
}
