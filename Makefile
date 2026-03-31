.PHONY: build test test-unit test-plugin test-e2e clean

build:
	cd server && npm install && npm run build

test: test-unit test-plugin

test-unit:
	cd server && npm test

test-plugin:
	godot --headless --script res://tests/test_plugin.gd

test-e2e:
	cd server && npm run test:e2e

clean:
	rm -rf server/dist server/node_modules
