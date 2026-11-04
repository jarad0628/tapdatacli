# PDK capability map

`connector.inspect` calls the connector's `registerCapabilities` and reports the functions actually registered by that JAR. The CLI must use this runtime manifest; the database brand or connector specification alone is not proof that an operation exists. Run `datasource capabilities NAME` to see the registered functions and the interactive commands currently mapped to them. Each mapped operation is checked again by the Java engine before invocation and returns a clear unsupported-capability error when absent.

## Interactive operations

| PDK function | CLI operation | Notes |
| --- | --- | --- |
| `connectionTest` / built-in connector check | `datasource test` | Connector's configured checks |
| `discoverSchema` / built-in connector discovery | `datasource load` | Loads table and field metadata |
| `get_table_names_function` | `datasource tables` | Connector-specific table listing |
| `get_table_info_function` | `datasource table-info` | Row count and storage estimates when available |
| `batch_read_function` | `datasource sample`, `datasource page`, `task start` | Bounded read, pagination, or CSV export |
| `stream_read_function` | `datasource stream` | Foreground CDC/event subscription; Ctrl+C requests stop; no task/checkpoint is created |
| `timestamp_to_stream_offset_function` | `datasource stream` | Converts current time (or `--since`) into the initial stream offset when registered; otherwise PDK receives a null offset |
| `batch_count_function` | `datasource count` | Exactness is connector-specific |
| `query_by_advance_filter_function` | `datasource query` | Filter, sort, projection, skip, and limit are passed through |
| `query_indexes_function` | `datasource indexes` | Lists connector-reported indexes |
| `query_constraints_function` | `datasource constraints` | Lists connector-reported constraints |
| `query_field_min_max_value_function` | `datasource minmax` | Optional `TapAdvanceFilter` scope |
| `get_current_timestamp_function` | `datasource now` | Returns connector-reported server time |
| `execute_command_v2_function` | `datasource sql` | Connector SQL behavior; requires explicit `--yes` |
| `execute_command_function` | `datasource command` | Connector-specific commands; requires explicit `--yes` |

## Other PDK functions

The remaining registered APIs are still reported in the manifest. This PDK version groups them as follows:

| API area | Registered function identifiers | Intended role / current CLI status |
| --- | --- | --- |
| Connection metadata | `check_table_name_function`, `get_charsets_function`, `connection_check_function`, `command_callback_function`, `connector_website_function`, `table_website_function` | Connector setup and UI metadata; not yet independent CLI operations |
| Common runtime | `memory_fetcher_function`, `memory_fetcher_v2_function`, `release_external_function`, `error_handle_function` | Resource management and runtime recovery callbacks |
| Batch and CDC source | `stream_read_one_by_one_function`, `stream_read_multi_connection_function`, `stream_read_multi_connection_one_by_one_function`, `get_stream_offset_function`, `flush_offset_function` | Other continuous read and offset lifecycle APIs; durable checkpointing is not implemented |
| Read planning / statistics | `count_by_partition_filter_function`, `get_read_partitions_function`, `count_raw_command_function`, `run_raw_command_function`, `query_hash_by_advance_filter_function`, `query_partition_tables_by_parent_name` | Partitioned reads, specialized counts, raw reads, and consistency checks; requires typed plan/offset handling |
| Target record operations | `write_record_function`, `query_by_filter_function`, `after_initial_sync_function`, `transaction_begin_function`, `transaction_commit_function`, `transaction_rollback_function` | Writes and transaction boundaries; requires record event construction, keys, result mapping, and transaction session state |
| Target schema operations | `create_table_function`, `create_table_v2_function`, `clear_table_function`, `drop_table_function`, `create_index_function`, `delete_index_function`, `create_constraint_function`, `drop_constraint_function`, `alter_database_time_zone_function`, `alter_field_attributes_function`, `alter_field_name_function`, `alter_table_charset_function`, `alter_table_ttl_function`, `drop_field_function`, `new_field_function` | DDL event application; requires typed schema events and explicit impact safeguards |
| Runtime event/control callbacks | `raw_data_callback_filter_function`, `raw_data_callback_filter_function_v2`, `control_function`, `process_control_function`, `export_event_sql_function` | Dataflow event transformation or flow control; not standalone commands |
| Additional command/read APIs | `execute_command_function`, `execute_command_v2_function`, `get_table_names_function`, `get_table_info_function`, `batch_count_function`, `batch_read_function`, `query_by_advance_filter_function`, `query_indexes_function`, `query_constraints_function`, `query_field_min_max_value_function`, `get_current_timestamp_function` | Exposed by the interactive operations table above |

This classification comes from the PDK `ConnectorFunctions`, `ConnectionFunctions`, and `CommonFunctions` registries. Exposing lifecycle callbacks as ad hoc commands would change their event and session contracts. They need explicit CLI workflows and runtime support before they can be called safely.

The capability manifest is the inventory, not a claim that every PDK callback is already a standalone CLI command. When adding a new workflow, add its typed JSON-RPC operation, capability check, bounded output/cancellation behavior, command help/completion, and this mapping entry together.
