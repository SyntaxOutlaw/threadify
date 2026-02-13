#!/bin/bash

# Version bump script for Threadify extension
# Updates version in composer.json, js/package.json, and js/src/forum/index.js

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Get current version from composer.json
CURRENT_VERSION=$(grep -oP '"version":\s*"\K[^"]+' composer.json)

if [ -z "$CURRENT_VERSION" ]; then
    echo -e "${RED}Error: Could not find current version in composer.json${NC}"
    exit 1
fi

echo -e "${GREEN}Current version: ${CURRENT_VERSION}${NC}"
echo ""
echo "Select version bump type:"
echo "  1) Major (x.0.0) - Major updates, potentially breaking changes"
echo "  2) Minor (1.x.0) - Minor updates, new features, backward compatible"
echo "  3) Patch (1.1.x) - Bug fixes, backward compatible"
echo ""
read -p "Enter choice [1-3]: " choice

case $choice in
    1)
        BUMP_TYPE="major"
        ;;
    2)
        BUMP_TYPE="minor"
        ;;
    3)
        BUMP_TYPE="patch"
        ;;
    *)
        echo -e "${RED}Invalid choice. Exiting.${NC}"
        exit 1
        ;;
esac

# Parse current version
IFS='.' read -ra VERSION_PARTS <<< "$CURRENT_VERSION"
MAJOR=${VERSION_PARTS[0]}
MINOR=${VERSION_PARTS[1]}
PATCH=${VERSION_PARTS[2]:-0}  # Default to 0 if patch not present

# Bump version according to semver
case $BUMP_TYPE in
    major)
        MAJOR=$((MAJOR + 1))
        MINOR=0
        PATCH=0
        ;;
    minor)
        MINOR=$((MINOR + 1))
        PATCH=0
        ;;
    patch)
        PATCH=$((PATCH + 1))
        ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"

echo ""
echo -e "${YELLOW}Bumping version: ${CURRENT_VERSION} → ${NEW_VERSION}${NC}"
echo ""

# Update composer.json
if [ -f "composer.json" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS uses BSD sed
        sed -i '' "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" composer.json
    else
        # Linux uses GNU sed
        sed -i "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" composer.json
    fi
    echo -e "${GREEN}✓ Updated composer.json${NC}"
else
    echo -e "${RED}✗ composer.json not found${NC}"
fi

# Update js/package.json
if [ -f "js/package.json" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" js/package.json
    else
        sed -i "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" js/package.json
    fi
    echo -e "${GREEN}✓ Updated js/package.json${NC}"
else
    echo -e "${RED}✗ js/package.json not found${NC}"
fi

# Update js/src/forum/index.js (version string in getThreadifyStatus function and JSDoc comment)
if [ -f "js/src/forum/index.js" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "s/version: '${CURRENT_VERSION}'/version: '${NEW_VERSION}'/" js/src/forum/index.js
        sed -i '' "s/@version ${CURRENT_VERSION}/@version ${NEW_VERSION}/" js/src/forum/index.js
    else
        sed -i "s/version: '${CURRENT_VERSION}'/version: '${NEW_VERSION}'/" js/src/forum/index.js
        sed -i "s/@version ${CURRENT_VERSION}/@version ${NEW_VERSION}/" js/src/forum/index.js
    fi
    echo -e "${GREEN}✓ Updated js/src/forum/index.js${NC}"
else
    echo -e "${RED}✗ js/src/forum/index.js not found${NC}"
fi

echo ""
echo -e "${GREEN}Version bumped successfully!${NC}"
echo -e "${YELLOW}New version: ${NEW_VERSION}${NC}"
echo ""
echo "Next steps:"
echo "  1. If extension is installed via Composer, update it:"
echo "     composer update syntaxoutlaw/threadify"
echo "     php flarum cache:clear"