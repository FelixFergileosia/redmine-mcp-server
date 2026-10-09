# Redmine MCP Server

Model Context Protocol (MCP) server for Redmine that provides comprehensive access to the Redmine REST API.

## Overview

This project is an MCP server that comprehensively covers Redmine's [REST API](https://www.redmine.org/projects/redmine/wiki/rest_api). It allows you to operate Redmine from MCP clients (such as Claude Desktop).

## Demonstration

Here are example videos showing how to use the Redmine MCP server with Claude Desktop:

### Creating an Issue

https://github.com/user-attachments/assets/075fb079-104c-404d-91f5-755b3882853b

*This demonstration also uses the [Playwright MCP](https://github.com/microsoft/playwright-mcp) for browser automation alongside the Redmine MCP server.*

### Getting Issue Information

https://github.com/user-attachments/assets/8f551082-6982-4513-8fe7-b0f111be982d

## Features

- 📋 **Comprehensive API Coverage**: Supports all functions available in Redmine's REST API
- 🔒 **Read-Only Mode**: Supports safe data reference mode
- 🔧 **Tool Filtering**: Control which tools are available using regex patterns
- 🏷️ **Tool Annotations**: Declares `readOnlyHint` so clients can tell read operations from write ones

## Prerequisites

### Cross-project Gantt coverage

`getGanttData` scans a user's issues across projects for working-day schedule
gaps. `getGanttDataDetail` explains selected dates from the cached scan, with
descriptions, relations and journals fetched only on request. Both tools are
read-only. See [inputs, coverage rules and examples](docs/gantt.md).

### Getting Redmine API Key

1. Log in to Redmine with administrator privileges
2. Go to "Administration" → "Settings" → "API" tab
3. Check "Enable REST web service"
4. Generate "API access key" in personal settings

For details, refer to [Redmine REST API documentation](https://www.redmine.org/projects/redmine/wiki/rest_api#Authentication).

## Configuration

### Environment Variables

The following environment variables are required (specified in MCP client configuration files):

- **REDMINE_URL** (Required): Base URL of the Redmine instance
  - Example: `https://redmine.example.com`
- **REDMINE_API_KEY** (Required in stdio mode): API key generated in Redmine
  - Set the API key obtained in prerequisites
  - Not used in http mode, where each request sends its own key (see [Shared HTTP Server](#shared-http-server-stateless))
- **REDMINE_MCP_READ_ONLY** (Optional): Enable read-only mode
  - `true`: Read-only mode (disables data modification operations)
  - `false` or unset: Allow all operations (default)
- **REDMINE_MCP_TOOLS_ALLOW_PATTERN** (Optional): Regex pattern to allow only matching tools
  - Example: `^get` (enable only tools starting with "get")
  - If unset, all tools are allowed (subject to other settings)
- **REDMINE_MCP_TOOLS_DENY_PATTERN** (Optional): Regex pattern to disable matching tools
  - Example: `^delete` (disable all tools starting with "delete")
  - If unset, no tools are denied (subject to other settings)
  - Deny pattern takes priority over allow pattern
- **REDMINE_MCP_REQUEST_TIMEOUT_MS** (Optional): Timeout for each request to Redmine in milliseconds
  - Default: `30000`. `0` disables the timeout
- **REDMINE_MCP_MAX_DOWNLOAD_BYTES** (Optional): Maximum size of an attachment or thumbnail download in bytes
  - Default: `0` (unlimited). Recommended in http mode, e.g. `10485760` (10 MB)
- **REDMINE_MCP_TRANSPORT** (Optional): `stdio` (default) or `http`
  - See [Shared HTTP Server](#shared-http-server-stateless) for the http-only variables

### MCP Client Configuration

#### Using npx (Recommended for quick start)

Add the following as MCP configuration for your AI agent:

```json
{
  "mcpServers": {
    "redmine": {
      "command": "npx",
      "args": ["-y", "@onozaty/redmine-mcp-server"],
      "env": {
        "REDMINE_URL": "https://your-redmine.example.com",
        "REDMINE_API_KEY": "your-api-key-here",
        "REDMINE_MCP_READ_ONLY": "true"
      }
    }
  }
}
```

#### Using Docker (Alternative)

If you prefer using Docker:

```json
{
  "mcpServers": {
    "redmine": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "REDMINE_URL=https://your-redmine.example.com",
        "-e", "REDMINE_API_KEY=your-api-key-here",
        "-e", "REDMINE_MCP_READ_ONLY=true",
        "ghcr.io/onozaty/redmine-mcp-server:latest"
      ]
    }
  }
}
```

**When to use Docker:**
- Enterprise environments requiring container isolation
- Reproducible deployments across different systems
- Environments where Node.js installation is restricted

Below are specific configuration methods for several MCP clients:

#### Claude Desktop

Add the following to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "redmine": {
      "command": "npx",
      "args": ["-y", "@onozaty/redmine-mcp-server"],
      "env": {
        "REDMINE_URL": "https://your-redmine.example.com",
        "REDMINE_API_KEY": "your-api-key-here",
        "REDMINE_MCP_READ_ONLY": "true"
      }
    }
  }
}
```

#### Claude Code

In Claude Code, you can add MCP servers using the following commands:

Local configuration:
```bash
claude mcp add redmine -e REDMINE_URL=https://your-redmine.example.com -e REDMINE_API_KEY=your-api-key-here -e REDMINE_MCP_READ_ONLY=true -- npx -y @onozaty/redmine-mcp-server
```

Project configuration:
```bash
claude mcp add -s project redmine -e REDMINE_URL=https://your-redmine.example.com -e REDMINE_API_KEY=your-api-key-here -e REDMINE_MCP_READ_ONLY=true -- npx -y @onozaty/redmine-mcp-server
```

User configuration (global):
```bash
claude mcp add -s user redmine -e REDMINE_URL=https://your-redmine.example.com -e REDMINE_API_KEY=your-api-key-here -e REDMINE_MCP_READ_ONLY=true -- npx -y @onozaty/redmine-mcp-server
```

#### Visual Studio Code

Project configuration (`.vscode/mcp.json`):

```json
{
  "servers": {
    "redmine": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@onozaty/redmine-mcp-server"],
      "env": {
        "REDMINE_URL": "https://your-redmine.example.com",
        "REDMINE_API_KEY": "your-api-key-here",
        "REDMINE_MCP_READ_ONLY": "true"
      }
    }
  }
}
```

User configuration (`settings.json`):

```json
{
  "mcp": {
    "servers": {
      "redmine": {
        "type": "stdio",
        "command": "npx",
        "args": ["-y", "@onozaty/redmine-mcp-server"],
        "env": {
          "REDMINE_URL": "https://your-redmine.example.com",
          "REDMINE_API_KEY": "your-api-key-here",
          "REDMINE_MCP_READ_ONLY": "true"
        }
      }
    }
  }
}
```

## Shared HTTP Server (Stateless)

Set `REDMINE_MCP_TRANSPORT=http` to run one server that a whole team connects to over the network, instead of each developer running their own process.

- **Stateless**: every `POST /mcp` request is handled by a fresh MCP server instance, so no session state is kept. The server can be restarted or run as multiple replicas behind a load balancer.
- **Per-developer API key**: the server holds no Redmine API key. Each developer sends their own key with every request, so Redmine applies that developer's permissions.
  - `X-Redmine-API-Key: <key>` or `Authorization: Bearer <key>`
  - Requests without a key are rejected with `401`.
- **Local file tools are disabled**: `uploadAttachmentFromLocalFile`, `downloadAttachmentToLocalFile` and `downloadThumbnailToLocalFile` would access the server's filesystem rather than the developer's, so they are not exposed in http mode. Use the Base64 variants instead.

Endpoints:

- `POST /mcp`: MCP Streamable HTTP endpoint
- `GET /healthz`: health check

HTTP-specific environment variables:

- **REDMINE_MCP_HTTP_HOST** (Optional): Listen address. Default: `0.0.0.0`
- **REDMINE_MCP_HTTP_PORT** (Optional): Listen port. Default: `3000`
- **REDMINE_MCP_HTTP_ALLOWED_HOSTS** (Optional): Comma-separated `Host` header values to accept, e.g. `mcp.example.com,mcp.example.com:443`. Enables DNS rebinding protection when set
- **REDMINE_MCP_HTTP_ALLOWED_ORIGINS** (Optional): Comma-separated `Origin` header values to accept. Enables DNS rebinding protection when set

> [!IMPORTANT]
> API keys travel in request headers. Always put the server behind HTTPS (e.g. a reverse proxy such as Caddy or nginx) when it is reachable by other machines.

### Running with Docker Compose

```yaml
services:
  redmine-mcp:
    build: .  # built from this repository
    restart: unless-stopped
    environment:
      REDMINE_URL: http://redmine:3000
      REDMINE_MCP_TRANSPORT: http
      REDMINE_MCP_MAX_DOWNLOAD_BYTES: "10485760"
      REDMINE_MCP_HTTP_ALLOWED_HOSTS: mcp.example.com
    ports:
      - "3000:3000"
```

### Connecting Clients

Claude Code:

```bash
claude mcp add --transport http redmine https://mcp.example.com/mcp --header "X-Redmine-API-Key: your-api-key-here"
```

Clients configured with JSON (e.g. Cursor, VS Code):

```json
{
  "mcpServers": {
    "redmine": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Redmine-API-Key": "your-api-key-here"
      }
    }
  }
}
```

## Available Features

This MCP server comprehensively supports the functions provided by [Redmine's REST API](https://www.redmine.org/projects/redmine/wiki/rest_api):

### Main Features

- **Issues**: Create, update, delete, search, and manage related issues
- **Projects**: Create, update, delete, archive, and manage memberships
- **Users**: Create, update, delete, and manage groups
- **Time Entries**: Record, update, and delete time entries
- **Wiki**: Create, update, delete pages, and manage versions
- **News**: Create, update, and delete news
- **Files**: Upload and download files
- **Attachments**: Upload, download files, and get thumbnails
- **Queries**: Execute saved queries
- **Custom Fields**: Get and manage custom fields
- **Roles**: Get and manage roles
- **Trackers**: Get and manage trackers
- **Issue Statuses**: Get and manage issue statuses
- **Search**: Cross-search functionality

### Read-Only Mode

By setting `REDMINE_MCP_READ_ONLY=true`, you can disable data modification operations. This allows safe data reference.

### Tool Filtering

You can control which tools are available using the following environment variables:

- **`REDMINE_MCP_TOOLS_ALLOW_PATTERN`**: Only tools whose names match this regex are enabled.
  - Example: `^get` enables only read-oriented tools like `getIssues`, `getProjects`, etc.
- **`REDMINE_MCP_TOOLS_DENY_PATTERN`**: Tools whose names match this regex are disabled.
  - Example: `^delete` disables all delete operations.

When both are set, deny takes priority. These can also be combined with `REDMINE_MCP_READ_ONLY`.

**Example: Allow only issue-related tools**
```json
"env": {
  "REDMINE_MCP_TOOLS_ALLOW_PATTERN": "Issue"
}
```

**Example: Disable all delete and archive operations**
```json
"env": {
  "REDMINE_MCP_TOOLS_DENY_PATTERN": "^(delete|archive)"
}
```

### Tool Annotations

Every tool declares the `readOnlyHint` annotation, so clients do not have to guess from the tool name whether a call modifies data: it is `true` for read operations (`getIssues`, `getProjects`, ...) and `false` for the ones that create, update or delete. Clients that honour the annotation can, for instance, run read operations without asking the user for confirmation.

### Available Tools

The following tools are available (based on [Redmine REST API](https://www.redmine.org/projects/redmine/wiki/rest_api) categories):

| Category | Tools |
|---|---|
| Issues | getIssues, getIssue, createIssue, updateIssue, deleteIssue, addWatcher, removeWatcher, addRelatedIssue, removeRelatedIssue |
| Projects | getProjects, getProject, createProject, updateProject, deleteProject, archiveProject, unarchiveProject, closeProject, reopenProject |
| Project Memberships | getMemberships, getMembership, createMembership, updateMembership, deleteMembership |
| Users | getUsers, getUser, createUser, updateUser, deleteUser, getCurrentUser |
| Time Entries | getTimeEntries, getTimeEntry, createTimeEntry, updateTimeEntry, deleteTimeEntry |
| News | getNewsList, getNewsListByProject, getNews, createNews, updateNews, deleteNews |
| Issue Relations | getIssueRelations, getIssueRelation, createIssueRelation, deleteIssueRelation |
| Versions | getVersionsByProject, getVersions, createVersion, updateVersion, deleteVersion |
| Wiki Pages | getWikiPages, getWikiPage, getWikiPageByVersion, updateWikiPage, deleteWikiPage |
| Queries | getQueries |
| Attachments | getAttachment, updateAttachment, deleteAttachment, uploadAttachmentFromLocalFile, uploadAttachmentFromBase64Content, downloadAttachmentToLocalFile, downloadAttachmentAsBase64Content, downloadThumbnailToLocalFile, downloadThumbnailAsBase64Content |
| Issue Statuses | getIssueStatuses |
| Trackers | getTrackers |
| Enumerations | getIssuePriorities, getTimeEntryActivities, getDocumentCategories |
| Issue Categories | getIssueCategories, getIssueCategory, createIssueCategory, updateIssueCategory, deleteIssueCategory |
| Roles | getRoles, getRole |
| Groups | getGroups, getGroup, createGroup, updateGroup, deleteGroup, addUserToGroup, removeUserFromGroup |
| Custom Fields | getCustomFields |
| Search | search |
| Files | getFiles, createFile |
| My Account | getMyAccount, updateMyAccount |
| Journals | updateJournal |

## License

MIT License

## Author

[onozaty](https://github.com/onozaty)

## Acknowledgments

- OpenAPI specification: [d-yoshi/redmine-openapi](https://github.com/d-yoshi/redmine-openapi)
- Code generation: [Orval](https://orval.dev/) - TypeScript client and schema generator from OpenAPI
