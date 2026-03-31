/**
 * Tool manifest test — ensures the set of registered tool names
 * matches an authoritative snapshot. Fails when tools are added or
 * removed, acting as a reminder to update both server and plugin.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { allTools } from '../dist/tools/index.js';

const EXPECTED_TOOL_NAMES = [
  "add_node",
  "assert_node_exists",
  "assert_property",
  "attach_script",
  "classdb_query",
  "clear_console_log",
  "clear_debug_overlay",
  "configure_input_map",
  "create_folder",
  "create_scene",
  "create_script",
  "debug_draw_overlay",
  "delete_file",
  "detach_script",
  "edit_script",
  "eval_editor_expression",
  "eval_expression",
  "game_get_properties",
  "game_get_property",
  "game_scene_tree",
  "game_screenshot",
  "generate_2d_asset",
  "get_collision_layers",
  "get_console_log",
  "get_debugger_errors",
  "get_errors",
  "get_input_map",
  "get_node_properties",
  "get_project_settings",
  "godot_process_status",
  "highlight_node",
  "is_playing",
  "list_dir",
  "list_scripts",
  "list_settings",
  "modify_node_property",
  "move_node",
  "open_in_godot",
  "performance_stats",
  "read_file",
  "read_scene",
  "remove_node",
  "rename_file",
  "rename_node",
  "rescan_filesystem",
  "run_scene",
  "scene_tree_dump",
  "search_project",
  "send_input_action",
  "send_key_event",
  "set_collision_shape",
  "set_sprite_texture",
  "setup_autoload",
  "start_godot",
  "stop_godot",
  "stop_scene",
  "update_project_settings",
  "validate_script",
  "wait_for_condition",
  "watch_property",
];

describe('Tool manifest', () => {
  it('allTools count matches expected', () => {
    assert.equal(
      allTools.length,
      EXPECTED_TOOL_NAMES.length,
      `Expected ${EXPECTED_TOOL_NAMES.length} tools, got ${allTools.length}. Update EXPECTED_TOOL_NAMES when adding/removing tools.`
    );
  });

  it('allTools names match expected set exactly', () => {
    const actual = allTools.map(t => t.name).sort();
    assert.deepEqual(actual, EXPECTED_TOOL_NAMES);
  });

  it('no duplicate tool names', () => {
    const names = allTools.map(t => t.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    assert.equal(dupes.length, 0, `Duplicate tool names: ${dupes.join(', ')}`);
  });
});
